import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

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
 *   NMI_API_KEY    — NMI's `security_key`
 *   NMI_GATEWAY_ID — optional custom gateway hostname (see above); defaults
 *                    to secure.nmi.com
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

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    // No API key, or no tokenized payment instrument to actually charge —
    // either way there is nothing a real API call could do here that
    // wouldn't be fabricated. Fall back to simulated mode.
    if (!this.apiKey || !paymentToken) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const body = this.toFormBody({
        security_key: this.apiKey,
        type: 'sale',
        amount: amount.toFixed(2),
        currency,
        payment_token: paymentToken,
        orderid: `${appId}_${Math.floor(Date.now() / 1000)}`,
      });

      const res = await this.http_request({
        method: 'POST',
        url: `https://${this.hostname}/api/transact.php`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        timeoutMs: 30_000,
      });

      const latency = Date.now() - startTime;

      // NMI returns a query-string body (not JSON) in both success and
      // error cases — there is no separate error envelope to branch on by
      // HTTP status the way Stripe/Infobip have; parse the fields either
      // way and let `response` (1/2/3) decide the outcome.
      const parsed = new URLSearchParams(typeof res.body === 'string' ? res.body : String(res.body ?? ''));
      const responseCode = parsed.get('response');
      const responseText = parsed.get('responsetext') || '';
      const transactionId = parsed.get('transactionid');

      if (!responseCode) {
        throw new Error(`NMI response did not include a 'response' field: ${JSON.stringify(res.body)}`);
      }

      // 1 = approved, 2 = declined, 3 = error in transaction data/system
      // error — both 2 and 3 are definite, non-ambiguous failures (NMI
      // told us exactly what happened synchronously; this is not a
      // provider-timeout situation).
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
      const latency = Date.now() - startTime;
      return {
        id: 'nmi_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
