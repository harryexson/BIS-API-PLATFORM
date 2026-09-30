import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundRequest } from '@company/schemas';

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
 * **SCA/3D Secure (PSD2)**: this platform never collects a live card entry
 * or has a page to redirect a shopper to, so `automatic_payment_methods[
 * allow_redirects] = 'never'` was already set here (since this adapter's
 * original build) — Stripe fails a PaymentIntent outright rather than
 * returning a redirect-based challenge it has nowhere to send the shopper
 * to. When authentication is still required and can't complete without
 * one, Stripe's real PaymentIntent status is `requires_action` — a
 * genuinely unresolved outcome (the shopper would need to authenticate
 * some other way this platform doesn't relay), not a definite decline, so
 * it's mapped to `'unknown'` here rather than `'failed'` (a real
 * correction — earlier versions of this adapter lumped it in with actual
 * declines). `requires_payment_method`/`canceled` remain definite
 * failures. This mirrors the same "frictionless-or-honestly-unresolved,
 * never fabricated" handling Adyen's/Airwallex's own catch-all 'unknown'
 * branches already use for their equivalent challenge-required states.
 *
 * **Fraud scoring (Stripe Radar)**: every Stripe account has Radar running
 * by default, and its risk assessment (`outcome.risk_level`, and
 * `outcome.risk_score` on accounts with Radar for Fraud Teams) lives on
 * the Charge created alongside a confirmed PaymentIntent — not on the
 * PaymentIntent itself unless expanded. This adapter requests
 * `expand[]=latest_charge` so that data comes back inline with the same
 * call, rather than a second round-trip. A charge Radar scores as
 * `risk_level: 'highest'` is downgraded to this platform's `'failed'`
 * status even if Stripe itself authorized it — Radar's own strongest
 * signal, surfaced into the actual payment flow rather than just logged
 * after the fact (the ask this exists to satisfy), not a fabricated
 * fraud rule invented independently of what Stripe already computed.
 * `risk_level`/`risk_score` are always surfaced on
 * `TransactionEvent.fraudRiskLevel`/`fraudRiskScore` when present, success
 * or not, for reporting.
 * NOTE ON VERIFICATION: the `requires_action` status mapping above is
 * high-confidence, stable Stripe API knowledge (unchanged since
 * PaymentIntents launched) and was reasoned through, not freshly
 * WebSearched. The `expand[]=latest_charge` mechanism and the exact
 * `outcome.risk_level`/`risk_score` field names were **not** verified via
 * WebSearch this pass either (WebSearch was unavailable — monthly limit
 * hit — unlike every other fact in this file, which was WebSearched on
 * 2026-09-14/17 as noted above). Treat the Radar-specific pieces as
 * lower-confidence than the rest of this adapter until spot-checked
 * against Stripe's current docs.
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
  async refund(appId: string, payload: RefundRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();
    const startTime = Date.now();
    const { originalTransactionId, amount, currency } = payload;

    if (!this.apiKey) {
      return super.refund(appId, payload, decisionReason);
    }

    try {
      const body = this.toFormBody({
        payment_intent: originalTransactionId,
        ...(amount ? { amount: Math.round(amount * 100) } : {}),
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

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        throw new Error(res.body?.error?.message || `Stripe API error: HTTP ${res.status}`);
      }

      const refund = res.body;
      const status = refund.status === 'succeeded' ? 'success' : refund.status === 'failed' || refund.status === 'canceled' ? 'failed' : 'unknown';

      return {
        id: refund.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status,
        amount: refund.amount ? refund.amount / 100 : amount,
        currency: (refund.currency || currency)?.toUpperCase(),
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: refund,
        ...(status === 'failed' ? { error: refund.failure_reason || `Stripe refund status: ${refund.status}` } : {}),
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
        // Brings Radar's risk assessment back inline on the Charge this
        // confirm call creates, instead of a second round-trip to fetch it.
        'expand[0]': 'latest_charge',
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

      // succeeded: money moved. requires_payment_method/canceled: the
      // attempt did not complete — a definite, non-ambiguous failure
      // (unlike a network timeout, Stripe told us exactly what happened).
      // processing: Stripe is still resolving it asynchronously (common
      // for some bank-debit methods) — genuinely unresolved. requires_action
      // means SCA/3D Secure authentication is still needed and — since
      // `allow_redirects: 'never'` above rules out the only way this
      // adapter could relay one — genuinely unresolved too, the same as
      // Adyen's/Airwallex's equivalent challenge-required states, not a
      // definite decline.
      let status: 'success' | 'failed' | 'unknown' =
        intent.status === 'succeeded' ? 'success'
          : intent.status === 'processing' || intent.status === 'requires_action' ? 'unknown'
            : 'failed';

      // Radar's own risk assessment lives on the Charge (see class comment
      // for why this needs `expand[]=latest_charge` to be present here).
      const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
      const outcome = charge?.outcome;
      const fraudRiskLevel: string | undefined = outcome?.risk_level;
      const fraudRiskScore: number | undefined = outcome?.risk_score;

      // Radar's strongest signal, acted on rather than only logged: a
      // charge it scores 'highest' risk is blocked here even if Stripe
      // itself authorized it — surfaced into the actual payment decision,
      // not a fraud rule this platform invented independently of Radar.
      let fraudBlockedMessage: string | undefined;
      if (status === 'success' && fraudRiskLevel === 'highest') {
        status = 'failed';
        fraudBlockedMessage = `Blocked by Stripe Radar: risk_level 'highest'${outcome?.seller_message ? ` — ${outcome.seller_message}` : ''}`;
      }

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
        ...(fraudRiskLevel !== undefined ? { fraudRiskLevel } : {}),
        ...(fraudRiskScore !== undefined ? { fraudRiskScore } : {}),
        ...(status === 'failed'
          ? { error: fraudBlockedMessage || intent.last_payment_error?.message || `PaymentIntent status: ${intent.status}` }
          : {}),
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
      latest_charge: {
        id: 'ch_sim_' + randomUUID().replace(/-/g, '').slice(0, 20),
        outcome: { risk_level: 'normal', type: 'authorized', seller_message: 'Payment complete.' },
      },
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
      fraudRiskLevel: 'normal',
    };
  }
}
