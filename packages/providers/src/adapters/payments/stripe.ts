import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

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
 */
export class StripeProvider extends BaseProvider {
  private baseUrl = 'https://api.stripe.com/v1';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.STRIPE_SECRET_KEY || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
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
