import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundRequest } from '@company/schemas';

/**
 * Real NMI (Network Merchants Inc.) payment provider adapter.
 *
 * Uses NMI's Direct Post / Gateway API (POST /api/transact.php), which —
 * unlike most other adapters in this package — is form-urlencoded in
 * *both* directions: the request body and the response body are both
 * `application/x-www-form-urlencoded` query strings, not JSON.
 *
 * Facts below (endpoint, request/response encoding, field names, response
 * codes) were verified via web search against NMI's public documentation
 * on 2026-09-14 (this environment's outbound network access to nmi.com is
 * restricted — see docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same
 * constraint on other adapters), not a live account. Treat as "built from
 * real, current documentation" rather than "certified against a live
 * sandbox."
 *
 * One genuine unknown, flagged rather than guessed at with false
 * confidence: NMI's own primary auth mechanism is a single `security_key`
 * (used here as NMI_API_KEY), which this adapter uses. This platform's
 * `.env.example` also defines `NMI_GATEWAY_ID`, which NMI's documented
 * transact.php parameters do not include by that name — it is used here,
 * at lower confidence, as an optional custom gateway hostname (some NMI
 * resellers run white-label gateways on their own domain rather than
 * secure.nmi.com). If that assumption is wrong for this deployment's
 * actual reseller, only the hostname needs correcting — the auth and
 * request/response shape are the well-documented, high-confidence part.
 *
 * This gateway's PaymentRequest contract never collects raw card data by
 * default (see PaymentRequest.paymentToken in @company/schemas — the same
 * design used for the Stripe adapter). NMI's tokenized equivalent is
 * Collect.js's `payment_token`; without one there is no instrument to
 * charge, so this adapter falls back to simulated processing exactly like
 * it does when no API key is configured.
 *
 * Environment variables:
 *   NMI_API_KEY            — NMI's `security_key`
 *   NMI_GATEWAY_ID         — optional custom gateway hostname (see above);
 *                            defaults to secure.nmi.com
 *   NMI_WEBHOOK_SIGNING_KEY — the signing key from the merchant control
 *                            panel's Settings > Webhooks, used only by
 *                            verifyProviderWebhookSignature() below.
 */
export class NMIProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.NMI_API_KEY || '';
  }

  private get hostname(): string {
    const raw = this.secrets.gateway_id || process.env.NMI_GATEWAY_ID || '';
    return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'secure.nmi.com';
  }

  private get webhookSigningKey(): string {
    return this.secrets.webhook_secret || process.env.NMI_WEBHOOK_SIGNING_KEY || '';
  }

  public isConfigured(): boolean {
    // gateway_id/hostname has a working default ('secure.nmi.com') — only
    // the API key is actually required.
    return Boolean(this.apiKey);
  }

  /**
   * Verifies NMI's real `Webhook-Signature` header — verified against
   * NMI's current documentation via WebSearch, 2026-09-17: `t=<nonce>,
   * s=<hex hmac>`. `t` is a random per-delivery nonce, *not* a timestamp
   * (NMI documents no replay/timestamp tolerance window on it — don't
   * treat it as one). Signed content is `<nonce>.<raw_body>`,
   * HMAC-SHA256'd with the signing key.
   */
  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.webhookSigningKey;
    if (!secret) return null;

    const header = headers['webhook-signature'];
    if (!header) return false;

    const parts: Record<string, string> = {};
    for (const part of header.split(',')) {
      const [key, value] = part.split('=');
      if (key && value) parts[key] = value;
    }
    const nonce = parts.t;
    const sig = parts.s;
    if (!nonce || !sig) return false;

    const { createHmac, timingSafeEqual } = await import('crypto');
    const expected = createHmac('sha256', secret).update(`${nonce}.${rawBody}`, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Refunds a settled transaction via the same POST /api/transact.php
   * endpoint used for charges, with `type=refund` — verified against
   * NMI's current documentation via WebSearch, 2026-09-17:
   * `transactionid` (this adapter's own TransactionEvent.id from the
   * original sale) is required, `amount` optional for a partial refund.
   * NMI's documented refund parameters list `username`/`password` auth,
   * but its `security_key` (used here, same as every other transaction
   * type this adapter sends) is NMI's single-credential replacement for
   * that pair, not endpoint-specific — reusing it here is the same
   * lower-confidence-but-flagged assumption already documented for
   * `NMI_GATEWAY_ID` in this file's class comment, not a new one.
   * Response is the same query-string envelope as a charge: `response`
   * (1=approved, 2=declined, 3=error).
   *
   * Falls back to a labeled simulated success when no API key is
   * configured — same rule processRequest already follows.
   */
  async refund(appId: string, payload: RefundRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();
    const startTime = Date.now();
    const { originalTransactionId, amount = 0, currency = 'USD' } = payload;

    if (!this.apiKey) {
      return super.refund(appId, payload, decisionReason);
    }

    try {
      const body = this.toFormBody({
        security_key: this.apiKey,
        type: 'refund',
        transactionid: originalTransactionId,
        amount: amount.toFixed(2),
      });

      const res = await this.http_request({
        method: 'POST',
        url: `https://${this.hostname}/api/transact.php`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        timeoutMs: 30_000,
        // No refund idempotency key is sent (gap register E14), so a refund
        // that may have reached the provider is never blindly re-sent.
        retryAmbiguous: false,
      });

      const latency = Date.now() - startTime;

      const parsed = new URLSearchParams(typeof res.body === 'string' ? res.body : String(res.body ?? ''));
      const responseCode = parsed.get('response');
      const responseText = parsed.get('responsetext') || '';
      const refundTransactionId = parsed.get('transactionid');

      if (!responseCode) {
        throw new Error(`NMI refund response did not include a 'response' field: ${JSON.stringify(res.body)}`);
      }

      const approved = responseCode === '1';
      return {
        id: refundTransactionId || 're_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status: approved ? 'success' : 'failed',
        amount,
        currency,
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: Object.fromEntries(parsed.entries()),
        ...(approved ? {} : { error: responseText || `NMI refund response code ${responseCode}` }),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 're_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status: 'failed',
        amount,
        currency,
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: null,
        error: err.message,
      };
    }
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    // No API key, or no tokenized payment instrument to actually charge —
    // either way there is nothing a real API call could do here that
    // wouldn't be fabricated. Fall back to simulated mode.
    if (!this.apiKey || !paymentToken) {
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: this.apiKey ? [] : ['NMI_API_KEY'],
        missingInputs: paymentToken ? [] : ['paymentToken'],
      });
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    // Deterministic per-payment `orderid`: bis_<payment_transaction_id>_<client
    // key | 'default'> (previously `<appId>_<unix seconds>`, gap register E7).
    //
    // PROVIDER LIMITATION: no idempotency-key parameter for transact.php
    // could be verified in NMI's Direct Post documentation from this
    // environment. NMI's own protection is processor-side duplicate
    // checking (`dup_seconds`), which keys on the transaction's details;
    // `orderid` is a merchant reference that makes a retried payment
    // identifiable/reconcilable, not a guaranteed dedupe key. 64 chars is a
    // conservative cap (identities that would exceed it are digested).
    const orderid = this.paymentIdempotencyIdentity(payload, { maxLength: 64 });

    try {
      const body = this.toFormBody({
        security_key: this.apiKey,
        type: 'sale',
        amount: amount.toFixed(2),
        currency,
        payment_token: paymentToken,
        orderid,
      });

      const res = await this.http_request({
        method: 'POST',
        url: `https://${this.hostname}/api/transact.php`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        timeoutMs: 30_000,
        // Phase 11-12 (PHASE3-01): transact.php has no idempotency key, so a
        // sale whose first attempt may have reached NMI (timeout, reset, 5xx)
        // is NEVER re-sent — the old default retried it up to 3 times, each
        // a potential second charge. Only provably-unsent attempts
        // (DNS/connect failure) and 429s are retried.
        retryAmbiguous: false,
      });

      const latency = Date.now() - startTime;

      // NMI returns a query-string body (not JSON) in both success and
      // error cases — there is no separate error envelope to branch on by
      // HTTP status the way Stripe/Infobip have; parse the fields either
      // way and let `response` (1/2/3) decide the outcome.
      const parsed = new URLSearchParams(typeof res.body === 'string' ? res.body : String(res.body ?? ''));
      const responseCode = parsed.get('response');
      const responseText = parsed.get('responsetext') || '';
      const resultCode = parsed.get('response_code') || '';
      const transactionId = parsed.get('transactionid');

      if (!responseCode) {
        const message = `NMI response did not include a 'response' field (HTTP ${res.status}): ${JSON.stringify(res.body)}`;
        // A 5xx, or a 2xx we cannot read: NMI may have run the sale.
        if (res.status >= 400) throw this.httpErrorOutcome(res, message);
        throw this.ambiguousOutcome(message, res.status);
      }

      // 1 = approved, 2 = declined (definite), 3 = error. Most response=3
      // results are definite rejections of bad input/configuration, EXCEPT
      // the ones that say nothing about whether the sale went through
      // (NMI's documented result-code table): 420/421 "communication error
      // (with issuer)" — the processor round-trip itself failed — and 430
      // "duplicate transaction at processor" / a gateway "Duplicate
      // transaction REFID:..." rejection — an identical sale already exists
      // at NMI, which may be this very payment. Those are ambiguous and must
      // not be failed over to another provider.
      if (responseCode !== '1' && responseCode !== '2') {
        const ambiguousNmiError =
          ['420', '421', '430'].includes(resultCode) || /duplicate/i.test(responseText);
        if (ambiguousNmiError) {
          throw this.ambiguousOutcome(
            `NMI response=${responseCode} response_code=${resultCode || 'n/a'}: ${responseText || 'no text'} — outcome of the sale is not known`,
            res.status,
          );
        }
      }
      const approved = responseCode === '1';

      const feePercent = this.config.transactionFeePercent || 2.2;
      const feeFlat = this.config.transactionFeeFlat || 0.20;
      const cost = approved ? (amount * feePercent) / 100 + feeFlat : 0;

      const responsePayload = Object.fromEntries(parsed.entries());

      return {
        id: transactionId || 'nmi_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status: approved ? 'success' : 'failed',
        amount,
        currency,
        latency,
        cost,
        decisionReason,
        payload,
        response: responsePayload,
        ...(approved ? {} : { error: responseText || `NMI response code ${responseCode}` }),
      };
    } catch (err: any) {
      return this.paymentFailureEvent({ appId, payload, decisionReason, err, startTime, amount, currency, idPrefix: 'nmi_err_' });
    }
  }

  /**
   * Simulated mode for when no API key is configured, or the caller has
   * no tokenized payment instrument to charge. Used for development/
   * testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'nmi_' + randomUUID().replace(/-/g, '').slice(0, 16);

    const feePercent = this.config.transactionFeePercent || 2.2;
    const feeFlat = this.config.transactionFeeFlat || 0.20;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      response: '1',
      responsetext: 'SUCCESS',
      authcode: randomUUID().replace(/-/g, '').slice(0, 6),
      transactionid: txId,
      avsresponse: 'Y',
      cvvresponse: 'M',
      amount: amount.toFixed(2),
      currency: currency,
    };

    return {
      id: txId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'payment',
      providerId: this.config.id,
      status: 'success',
      amount,
      currency,
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload,
    };
  }
}
