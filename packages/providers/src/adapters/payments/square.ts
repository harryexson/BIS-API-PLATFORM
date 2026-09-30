import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundRequest } from '@company/schemas';

// A valid past Square API version — Square's versioning model translates
// any request tagged with a real past version to its current schema, so
// this doesn't need to be "the latest" to work, only a genuine version
// that has existed. Not independently re-verified as current this pass
// (see class comment); if Square ever rejects it outright, replacing this
// constant with today's actual version string is the fix, not a redesign.
const SQUARE_VERSION = '2025-01-23';

/**
 * Real Square payment provider adapter.
 *
 * Uses Square's Payments API (`POST /v2/payments`). Facts below (base
 * hosts, auth, request/response shape, refund endpoint, error envelope,
 * webhook signature scheme) were verified via web search against
 * Square's public developer documentation on 2026-09-29 (this
 * environment's outbound network access to squareup.com is restricted —
 * see docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint
 * on other adapters), not a live account. Treat as "built from real,
 * current documentation" rather than "certified against a live
 * sandbox." The exact `Square-Version` date header value specifically
 * (see the constant above) is a lower-confidence pick within that pass —
 * everything else was directly corroborated.
 *
 * Like every other card adapter here, this gateway never collects raw
 * card data — `PaymentRequest.paymentToken` is used directly as Square's
 * `source_id` (a card-on-file id, per Square's own "provide the ID of
 * the card on file as source_id and the customer_id" guidance). Charging
 * a card on file also requires a `customer_id`, a field `PaymentRequest`
 * has no first-class slot for — read from
 * `payload.metadata.squareCustomerId`, falling back to `appId` (a real,
 * available identifier, not fabricated) when absent, the same fallback
 * pattern adyen.ts already uses for its own `shopperReference`.
 * `autocomplete: true` (Square's own default, set explicitly here for
 * clarity) captures immediately — no separate capture call. Without an
 * access token or a `paymentToken`, this adapter falls back to simulated
 * processing — never a real call with nothing to charge.
 *
 * Every request requires an `Idempotency-Key` in the body (not a header,
 * unlike Stripe/Adyen) and a `Square-Version` header pinning the request
 * to a specific API schema version.
 *
 * Payment `status` is confirmed real for `COMPLETED` (this platform's
 * charge success — `autocomplete: true` captured immediately) and
 * `CANCELED`/`FAILED` (definite failures). `APPROVED` — authorized but,
 * unusually given `autocomplete: true`, not yet captured — is genuinely
 * unresolved and reported as this platform's `'unknown'`, never
 * fabricated either way.
 *
 * Refunds (`POST /v2/refunds`) are confirmed real for `COMPLETED`
 * (success) and `REJECTED`/`FAILED` (definite failure); `PENDING` is
 * async and reported as `'unknown'`, the same asynchronous-refund
 * pattern already used for Adyen/Checkout.com here.
 *
 * Native inbound-webhook signature verification **is** implemented:
 * Square's real scheme signs `notification_url + raw_body` (concatenated
 * directly) with HMAC-SHA256 keyed by the webhook subscription's own
 * signature key, base64-encoded, in the `x-square-hmacsha256-signature`
 * header. Unlike every other adapter's webhook check here, this one
 * needs the exact notification URL configured on the Square subscription
 * (not just the raw body) to reconstruct the signed content — configured
 * separately via `webhook_notification_url` below, since guessing it
 * from a request would silently break verification.
 *
 * Environment variables:
 *   SQUARE_ACCESS_TOKEN          — from the Square Developer Dashboard
 *   SQUARE_LOCATION_ID           — optional; Square defaults to the
 *     seller's main location when omitted
 *   SQUARE_WEBHOOK_SIGNATURE_KEY — the webhook subscription's signature key
 *   SQUARE_WEBHOOK_NOTIFICATION_URL — the exact URL registered for that
 *     subscription, required by the signature scheme itself (see above)
 */
export class SquareProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get accessToken(): string {
    return this.secrets.access_token || process.env.SQUARE_ACCESS_TOKEN || '';
  }

  private get locationId(): string {
    return this.secrets.location_id || process.env.SQUARE_LOCATION_ID || '';
  }

  private get webhookSignatureKey(): string {
    return this.secrets.webhook_signature_key || process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
  }

  private get webhookNotificationUrl(): string {
    return this.secrets.webhook_notification_url || process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || '';
  }

  private get baseUrl(): string {
    return this.config.environment === 'live' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  }

  public isConfigured(): boolean {
    return Boolean(this.accessToken);
  }

  /**
   * Verifies Square's real `x-square-hmacsha256-signature` header:
   * base64 HMAC-SHA256 of `notification_url + raw_body`, keyed by the
   * webhook subscription's signature key — verified via WebSearch,
   * 2026-09-29.
   */
  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.webhookSignatureKey;
    const notificationUrl = this.webhookNotificationUrl;
    if (!secret || !notificationUrl) return null;

    const header = headers['x-square-hmacsha256-signature'];
    if (!header) return false;

    const { createHmac, timingSafeEqual } = await import('crypto');
    const expected = createHmac('sha256', secret).update(`${notificationUrl}${rawBody}`, 'utf8').digest('base64');
    const a = Buffer.from(expected, 'base64');
    const b = Buffer.from(header, 'base64');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async refund(appId: string, payload: RefundRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();
    const startTime = Date.now();
    const { originalTransactionId, amount = 0, currency = 'USD' } = payload;

    if (!this.isConfigured()) {
      return super.refund(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/v2/refunds`,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Square-Version': SQUARE_VERSION,
        },
        body: {
          idempotency_key: 'refund_' + originalTransactionId + '_' + Math.round(amount * 100),
          payment_id: originalTransactionId,
          amount_money: { amount: Math.round(amount * 100), currency: currency.toUpperCase() },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const err = res.body?.errors?.[0];
        throw new Error(err?.detail || `Square API error: HTTP ${res.status}`);
      }

      const refund = res.body?.refund;
      const status = refund?.status === 'COMPLETED' ? 'success' : ['REJECTED', 'FAILED'].includes(refund?.status) ? 'failed' : 'unknown';

      return {
        id: refund?.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status,
        amount: refund?.amount_money?.amount ? refund.amount_money.amount / 100 : amount,
        currency: (refund?.amount_money?.currency || currency).toUpperCase(),
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: refund,
        ...(status === 'failed' ? { error: `Square refund status: ${refund?.status}` } : {}),
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

    if (!this.isConfigured() || !paymentToken) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const customerId = String((payload.metadata as any)?.squareCustomerId || appId);
      const idempotencyKey = (payload as any).idempotencyKey
        ? `bis_${appId}_${(payload as any).idempotencyKey}`
        : `bis_${appId}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/v2/payments`,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Square-Version': SQUARE_VERSION,
        },
        body: {
          idempotency_key: idempotencyKey,
          source_id: paymentToken,
          customer_id: customerId,
          amount_money: { amount: Math.round(amount * 100), currency: currency.toUpperCase() },
          autocomplete: true,
          ...(this.locationId ? { location_id: this.locationId } : {}),
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const err = res.body?.errors?.[0];
        throw new Error(err?.detail || `Square API error: HTTP ${res.status}`);
      }

      const payment = res.body?.payment;
      if (!payment) {
        throw new Error('Square CreatePayment response did not include a payment object');
      }

      const feePercent = this.config.transactionFeePercent || 0;
      const feeFlat = this.config.transactionFeeFlat || 0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      // COMPLETED: autocomplete captured immediately, money moved.
      // CANCELED/FAILED: definite, non-ambiguous failures. APPROVED
      // (authorized but not yet captured, unusual given autocomplete:true)
      // is genuinely unresolved, never guessed at either way.
      const status =
        payment.status === 'COMPLETED' ? 'success'
          : ['CANCELED', 'FAILED'].includes(payment.status) ? 'failed'
            : 'unknown';

      return {
        id: payment.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status,
        amount,
        currency: currency.toUpperCase(),
        latency,
        cost,
        decisionReason,
        payload,
        response: payment,
        ...(status === 'failed' ? { error: `Square payment status: ${payment.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'square_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no access token is configured, or the caller
   * has no tokenized payment instrument to charge.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'square_sim_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const feePercent = this.config.transactionFeePercent || 0;
    const feeFlat = this.config.transactionFeeFlat || 0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      id: txId,
      status: 'COMPLETED',
      amount_money: { amount: Math.round(amount * 100), currency: currency.toUpperCase() },
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
