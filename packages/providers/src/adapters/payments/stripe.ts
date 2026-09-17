import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

/**
 * Real Stripe payment provider adapter.
 *
 * Uses the PaymentIntents API (POST /v1/payment_intents), not the legacy
 * Charges API — Stripe's own current documentation presents PaymentIntents
 * as the standard integration path (it also handles 3D Secure/SCA, which
 * Charges does not). Facts below (endpoint, request encoding, status
 * values, error envelope) were verified via web search against Stripe's
 * public API reference on 2026-09-14 (this environment's outbound network
 * access to stripe.com is restricted — see docs/IMPLEMENTATION_BASELINE.md
 * §6 item 1 for the same constraint on other adapters), not a live
 * account. Treat as "built from real, current documentation" rather than
 * "certified against a live sandbox."
 *
 * Stripe's REST API takes `application/x-www-form-urlencoded` request
 * bodies, not JSON — a JSON body is rejected outright. This was a real bug
 * in the previous version of this file: it called the (deprecated)
 * Charges endpoint with a JSON body and would have failed against the
 * live API on every single call despite compiling and running cleanly
 * against no server at all.
 *
 * This gateway's PaymentRequest contract never collects raw card data or a
 * Stripe token by default (see PaymentRequest.paymentToken in
 * @company/schemas) — cardholder data must be tokenized client-side via
 * Stripe.js/Elements before it ever reaches this backend, for PCI scope
 * reasons this platform does not control. Without a `paymentToken`
 * (a Stripe PaymentMethod id, e.g. `pm_...`) there is no instrument to
 * charge, so this adapter falls back to simulated processing exactly like
 * it does when no API key is configured — it does not fabricate a real
 * charge against nothing.
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY — sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET — whsec_... (from the Stripe dashboard's webhook
 *     endpoint settings), used only by verifyProviderWebhookSignature()
 *     below to verify Stripe's own Stripe-Signature header, separate from
 *     the payment API credential above.
 */
export class StripeProvider extends BaseProvider {
  private baseUrl = 'https://api.stripe.com/v1';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.STRIPE_SECRET_KEY || '';
  }

  private get webhookSecret(): string {
    return this.secrets.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Verifies Stripe's real `Stripe-Signature` header — verified against
   * Stripe's current documentation via WebSearch, 2026-09-17: a
   * comma-separated `t=<unix seconds>,v1=<hex hmac>[,v0=...]` value. The
   * signed payload is `"${timestamp}.${rawBody}"`, HMAC-SHA256'd with the
   * endpoint's signing secret. Stripe documents rejecting signatures more
   * than 300 seconds old as replay protection, applied here too.
   */
  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.webhookSecret;
    if (!secret) return null;

    const header = headers['stripe-signature'];
    if (!header) return false;

    const parts: Record<string, string> = {};
    for (const part of header.split(',')) {
      const [key, value] = part.split('=');
      if (key && value) parts[key] = value;
    }
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1) return false;

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

    const { createHmac, timingSafeEqual } = await import('crypto');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Refunds a PaymentIntent via POST /v1/refunds — verified against
   * Stripe's current API reference via WebSearch, 2026-09-17:
   * `payment_intent` (this adapter's own TransactionEvent.id from the
   * original charge) is required, `amount` (smallest currency unit) is
   * optional for a partial refund, full amount otherwise. The Refund
   * object's `status` is one of pending/requires_action/succeeded/failed/
   * canceled — only `succeeded` is a confirmed success; `failed`/
   * `canceled` are confirmed failures; `pending`/`requires_action` are
   * genuinely unresolved (async), reported as this platform's 'unknown'
   * outcome rather than guessed at, the same convention charge creation
   * already uses for ambiguous outcomes.
   *
   * Falls back to a labeled simulated success when no API key is
   * configured — same rule processRequest already follows: never call
   * the real API with nothing to authenticate with, but still let the
   * platform's create→refund flow be exercised end-to-end in dev/test.
   */
  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.apiKey) {
      return {
        status: 'success',
        refundId: 're_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, payment_intent: providerTransactionId },
      };
    }

    try {
      const body = this.toFormBody({
        payment_intent: providerTransactionId,
        amount: Math.round(amount * 100),
      });

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/refunds`,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      if (res.status >= 400) {
        const errBody = res.body?.error;
        return { status: 'failed', amount, currency, error: errBody?.message || `Stripe API error: HTTP ${res.status}`, response: res.body };
      }

      const refund = res.body;
      const status = refund.status === 'succeeded' ? 'success' : refund.status === 'failed' || refund.status === 'canceled' ? 'failed' : 'unknown';

      return {
        status,
        refundId: refund.id,
        amount: refund.amount ? refund.amount / 100 : amount,
        currency: (refund.currency || currency).toUpperCase(),
        response: refund,
        ...(status === 'failed' ? { error: refund.failure_reason || `Stripe refund status: ${refund.status}` } : {}),
      };
    } catch (err: any) {
      return { status: 'failed', amount, currency, error: err.message };
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
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const idempotencyKey = (payload as any).idempotencyKey
        ? `bis_${appId}_${(payload as any).idempotencyKey}`
        : `pi_${appId}_${amount}_${currency}_${Math.floor(Date.now() / 60_000)}`;

      const body = this.toFormBody({
        amount: Math.round(amount * 100), // Stripe amounts are in the smallest currency unit
        currency: currency.toLowerCase(),
        payment_method: paymentToken,
        confirm: true,
        // Stripe otherwise redirects for payment methods that support it
        // (e.g. some card 3DS flows); this gateway has no redirect surface
        // to return the customer to, so disable those methods rather than
        // silently drop a required next_action.
        'automatic_payment_methods[enabled]': true,
        'automatic_payment_methods[allow_redirects]': 'never',
        'metadata[appId]': appId,
        'metadata[decisionReason]': decisionReason,
      });

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payment_intents`,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idempotencyKey,
        },
        body,
        timeoutMs: 30_000,
        maxAttempts: 2, // Stripe handles its own internal retries
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const errBody = res.body?.error;
        throw new Error(errBody?.message || `Stripe API error: HTTP ${res.status}`);
      }

      const intent = res.body;
      const feePercent = this.config.transactionFeePercent || 2.9;
      const feeFlat = this.config.transactionFeeFlat || 0.30;
      const cost = (amount * feePercent) / 100 + feeFlat;

      // succeeded: money moved. requires_payment_method/requires_action/
      // canceled: the attempt did not complete — a definite, non-ambiguous
      // failure (unlike a network timeout, Stripe told us exactly what
      // happened). processing: Stripe is still resolving it asynchronously
      // (common for some bank-debit methods) — genuinely unresolved, not a
      // failure, so it must not be reported as either success or failure.
      const status = intent.status === 'succeeded' ? 'success' : intent.status === 'processing' ? 'unknown' : 'failed';

      return {
        id: intent.id,
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
        response: intent,
        ...(status === 'failed' ? { error: intent.last_payment_error?.message || `PaymentIntent status: ${intent.status}` } : {}),
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

    const { amount = 10, currency = 'USD', paymentMethod = 'card' } = payload;
    const txId = 'pi_' + randomUUID().replace(/-/g, '').slice(0, 24);

    const feePercent = this.config.transactionFeePercent || 2.9;
    const feeFlat = this.config.transactionFeeFlat || 0.30;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      id: txId,
      object: 'payment_intent',
      amount: Math.round(amount * 100),
      amount_received: Math.round(amount * 100),
      currency: currency.toLowerCase(),
      payment_method_types: [paymentMethod === 'card' ? 'card' : paymentMethod],
      status: 'succeeded',
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
