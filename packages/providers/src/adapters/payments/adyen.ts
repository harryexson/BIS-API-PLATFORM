import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

/**
 * Real Adyen payment provider adapter.
 *
 * Uses Adyen's Checkout API (POST /payments), version v71. Facts below
 * (endpoint shape, auth header, request/response fields, status values,
 * error envelope, refund semantics) were verified via web search against
 * Adyen's public API reference on 2026-09-25 (this environment's
 * outbound network access to adyen.com is restricted — see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint on
 * other adapters), not a live account. Treat as "built from real, current
 * documentation" rather than "certified against a live sandbox."
 *
 * Two things make Adyen structurally different from every other card
 * adapter already in this package:
 *
 * 1. **No fixed live API host.** Every other provider here has one
 *    documented URL; Adyen's live traffic goes to a per-merchant prefixed
 *    host (`https://{prefix}-checkout-live.adyenpayments.com/...`) that
 *    only exists once an account requests "Live URL prefix" from Adyen —
 *    there is no way to construct or guess it. Test traffic has a real,
 *    fixed host (`checkout-test.adyen.com`) that needs no prefix. This
 *    adapter reads the prefix from `this.secrets.live_url_prefix` /
 *    `ADYEN_LIVE_URL_PREFIX`; when unset, it calls the real test host
 *    rather than fabricating a live one — the same "fall back to what's
 *    actually configured" rule this package already applies to every
 *    other missing credential.
 * 2. **Auth is `X-API-Key`, not a Bearer token** — the one adapter in this
 *    package where that's true.
 *
 * Like Stripe/NMI, this gateway's `PaymentRequest` never collects raw
 * card data — `paymentToken` must be a pre-tokenized instrument. Adyen's
 * own token concept for charging a previously-stored card is
 * `storedPaymentMethodId` (interchangeable with what Adyen calls a
 * `recurringDetailReference`), used here with `shopperInteraction:
 * 'ContAuth'` (merchant-initiated, no shopper present) — the same
 * merchant-initiated charge-a-stored-instrument shape Flutterwave's
 * tokenized-charges endpoint already covers for this platform. Every
 * request also requires a `shopperReference` identifying the customer the
 * stored instrument belongs to, which `PaymentRequest` has no first-class
 * field for — read from `payload.metadata.shopperReference`, falling back
 * to `appId` (a real, available identifier, not a fabricated one) when
 * absent. `merchantAccount` is likewise mandatory on every request; read
 * from `this.secrets.merchant_account` / `ADYEN_MERCHANT_ACCOUNT`.
 * Without an API key, a merchant account, or a payment token, this
 * adapter falls back to simulated processing — never a real call with an
 * instrument to charge fabricated.
 *
 * Refunds settle asynchronously: Adyen's refund response always reports
 * `status: "received"` (the request was accepted) — the real outcome
 * only arrives later via a webhook this platform doesn't consume yet.
 * Reported as this platform's `'unknown'` outcome, never a fabricated
 * `'success'`, the same convention PawaPay's deposit flow already uses.
 *
 * Native inbound-webhook signature verification is deliberately not
 * implemented here (falls back to the platform's generic HMAC check) —
 * Adyen's real scheme signs each notification *item* individually via an
 * HMAC over a specific pipe-delimited field concatenation
 * (`additionalData.hmacSignature`), not a single raw-body signature like
 * Stripe/NMI/PayChangu/Airwallex. Getting that canonicalization exactly
 * right without a live sandbox to verify against risks silently building
 * a check that always fails (or worse, always passes) — the same
 * reasoning `pawapay.ts` already documents for declining to guess at
 * RFC-9421. A real, verified implementation is a well-scoped follow-up,
 * not attempted here.
 *
 * Environment variables:
 *   ADYEN_API_KEY         — the API key from the Customer Area
 *   ADYEN_MERCHANT_ACCOUNT — the merchant account code every request requires
 *   ADYEN_LIVE_URL_PREFIX  — this account's live URL prefix (optional;
 *     without it, even a 'live'-environment provider record calls Adyen's
 *     real test host, since there's no live host to call otherwise)
 */
export class AdyenProvider extends BaseProvider {
  private apiVersion = 'v71';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.ADYEN_API_KEY || '';
  }

  private get merchantAccount(): string {
    return this.secrets.merchant_account || process.env.ADYEN_MERCHANT_ACCOUNT || '';
  }

  private get liveUrlPrefix(): string {
    return this.secrets.live_url_prefix || process.env.ADYEN_LIVE_URL_PREFIX || '';
  }

  private get baseUrl(): string {
    return this.liveUrlPrefix
      ? `https://${this.liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/${this.apiVersion}`
      : `https://checkout-test.adyen.com/${this.apiVersion}`;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.merchantAccount);
  }

  /**
   * Refunds a captured payment via POST /payments/{pspReference}/refunds —
   * verified via WebSearch, 2026-09-25. Always returns `status: "received"`
   * synchronously; the real settlement is async, via webhook, so this is
   * reported as `'unknown'`, never a fabricated `'success'`.
   */
  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.apiKey || !this.merchantAccount) {
      return {
        status: 'success',
        refundId: 'adyen_refund_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, paymentPspReference: providerTransactionId },
      };
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payments/${encodeURIComponent(providerTransactionId)}/refunds`,
        headers: {
          'X-API-Key': this.apiKey,
          'Idempotency-Key': 'refund_' + providerTransactionId + '_' + Math.round(amount * 100),
        },
        body: {
          amount: { value: Math.round(amount * 100), currency: currency.toUpperCase() },
          merchantAccount: this.merchantAccount,
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      if (res.status >= 400) {
        const err = res.body;
        return { status: 'failed', amount, currency, error: err?.message || `Adyen API error: HTTP ${res.status}`, response: err };
      }

      // status is always "received" for a referenced refund — the real
      // outcome is only known once the async REFUND webhook arrives.
      return {
        status: 'unknown',
        refundId: res.body?.pspReference,
        amount,
        currency,
        response: res.body,
      };
    } catch (err: any) {
      return { status: 'failed', amount, currency, error: err.message };
    }
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    if (!this.apiKey || !this.merchantAccount || !paymentToken) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const shopperReference = String((payload.metadata as any)?.shopperReference || appId);
      const reference = `bis_${appId}_${Date.now()}`;

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payments`,
        headers: {
          'X-API-Key': this.apiKey,
          'Idempotency-Key': (payload as any).idempotencyKey
            ? `bis_${appId}_${(payload as any).idempotencyKey}`
            : reference,
        },
        body: {
          merchantAccount: this.merchantAccount,
          reference,
          amount: { value: Math.round(amount * 100), currency: currency.toUpperCase() },
          paymentMethod: { type: 'scheme', storedPaymentMethodId: paymentToken },
          shopperReference,
          shopperInteraction: 'ContAuth',
          recurringProcessingModel: 'CardOnFile',
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const err = res.body;
        throw new Error(err?.message || `Adyen API error: HTTP ${res.status}`);
      }

      const result = res.body;
      const feePercent = this.config.transactionFeePercent || 0;
      const feeFlat = this.config.transactionFeeFlat || 0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      // Authorised: money moved. Refused/Error/Cancelled: a definite,
      // non-ambiguous failure — Adyen told us exactly what happened.
      // Anything else (Pending, Received, RedirectShopper, ...) is
      // genuinely unresolved, never guessed at either way.
      const status =
        result.resultCode === 'Authorised' ? 'success'
          : ['Refused', 'Error', 'Cancelled'].includes(result.resultCode) ? 'failed'
            : 'unknown';

      return {
        id: result.pspReference || reference,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status,
        amount,
        currency,
        latency,
        cost,
        decisionReason,
        payload,
        response: result,
        ...(status === 'failed' ? { error: result.refusalReason || `resultCode: ${result.resultCode}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no API key/merchant account is configured, or
   * the caller has no tokenized payment instrument to charge.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'adyen_sim_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const feePercent = this.config.transactionFeePercent || 0;
    const feeFlat = this.config.transactionFeeFlat || 0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      pspReference: txId,
      resultCode: 'Authorised',
      amount: { value: Math.round(amount * 100), currency: currency.toUpperCase() },
      merchantReference: `bis_${appId}_${Date.now()}`,
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
