import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

/**
 * Real PayPal payment provider adapter.
 *
 * Uses PayPal's Orders API v2 (`POST /v2/checkout/orders`). Facts below
 * (OAuth flow, base hosts, request/response shape, refund endpoint) were
 * verified via web search against PayPal's public developer documentation
 * on 2026-09-29 (this environment's outbound network access to
 * paypal.com is restricted — see docs/IMPLEMENTATION_BASELINE.md §6 item 1
 * for the same constraint on other adapters), not a live account. Treat
 * as "built from real, current documentation" rather than "certified
 * against a live sandbox."
 *
 * **Structural note, unlike most other adapters here**: PayPal's Orders
 * API is fundamentally a redirect-based checkout — the buyer normally
 * approves an order on paypal.com before it can be captured, which this
 * gateway (no customer-facing redirect surface — see stripe.ts's own
 * class comment for the same constraint) can't complete. What this
 * adapter uses instead is PayPal's real **vaulted/merchant-initiated**
 * flow: `payment_source.paypal.vault_id` charges a previously-saved
 * PayPal account with no redirect and no payer present, exactly the
 * "merchant-initiated transaction against a stored instrument" shape
 * every other adapter in this package already uses. This platform's
 * `PaymentRequest.paymentToken` is used directly as that `vault_id`.
 * `intent: 'CAPTURE'` with a valid `payment_source` captures in the same
 * call — no separate capture request needed. Without an API key/secret
 * or a `paymentToken`, this adapter falls back to simulated processing —
 * never a real call with nothing to charge.
 *
 * Auth is OAuth 2.0 client-credentials: `POST /v1/oauth2/token` with HTTP
 * Basic auth (`clientId:clientSecret`) and a form body of
 * `grant_type=client_credentials`, returning a Bearer `access_token` this
 * adapter caches in-memory until shortly before its real `expires_in`
 * (PayPal's tokens are long-lived, typically ~9 hours) — the same
 * cache-and-reuse pattern airwallex.ts already uses for its own
 * short-lived-token login step.
 *
 * `TransactionEvent.id` is the **capture** id
 * (`purchase_units[0].payments.captures[0].id`), not the order id — a
 * refund needs the capture id specifically (`POST
 * /v2/payments/captures/{id}/refund`), so the order id alone wouldn't be
 * enough for this platform's refund flow to work.
 *
 * Order `status` is confirmed real for `COMPLETED` (this platform's charge
 * success — the vaulted payment_source captured immediately) and
 * `VOIDED` (a definite failure). `PAYER_ACTION_REQUIRED` (PayPal still
 * wants a redirect despite the vaulted instrument — should be rare given
 * a valid vault_id, but not impossible) and anything else report this
 * platform's `'unknown'` outcome, never fabricated either way, the same
 * "no redirect flow to relay a challenge through" convention Stripe's/
 * Adyen's/Airwallex's own adapters already use for their equivalent
 * unresolved states.
 *
 * Native inbound-webhook signature verification is deliberately not
 * implemented here (falls back to the platform's generic HMAC check) —
 * PayPal's real scheme requires a server-side call to PayPal's own
 * `POST /v1/notifications/verify-webhook-signature` endpoint (verification
 * is delegated to PayPal itself, not a local HMAC/signature computation
 * this adapter could do offline), a meaningfully different shape from
 * every other adapter's local-verification pattern in this package. A
 * real, verified implementation of that server-round-trip check is a
 * well-scoped follow-up, not attempted here — same reasoning pawapay.ts
 * and adyen.ts already document for their own declined webhook schemes.
 *
 * Environment variables:
 *   PAYPAL_CLIENT_ID     — from the PayPal Developer Dashboard's app credentials
 *   PAYPAL_CLIENT_SECRET — from the same app credentials
 */
export class PayPalProvider extends BaseProvider {
  private cachedToken: { token: string; expiresAtMs: number } | undefined;

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get clientId(): string {
    return this.secrets.client_id || process.env.PAYPAL_CLIENT_ID || '';
  }

  private get clientSecret(): string {
    return this.secrets.client_secret || process.env.PAYPAL_CLIENT_SECRET || '';
  }

  private get baseUrl(): string {
    return this.config.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  public isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  // Reuses a cached token until ~1 minute before it expires, the same
  // pattern airwallex.ts uses for its own login step.
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - now > 60_000) {
      return this.cachedToken.token;
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.http_request({
      method: 'POST',
      url: `${this.baseUrl}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      maxAttempts: 1,
    });

    if (res.status >= 400 || !res.body?.access_token) {
      throw new Error(res.body?.error_description || `PayPal authentication failed: HTTP ${res.status}`);
    }

    const expiresAtMs = now + (Number(res.body.expires_in) || 9 * 60 * 60) * 1000;
    this.cachedToken = { token: res.body.access_token, expiresAtMs };
    return res.body.access_token;
  }

  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.isConfigured()) {
      return {
        status: 'success',
        refundId: 'paypal_refund_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, captureId: providerTransactionId },
      };
    }

    try {
      const token = await this.getAccessToken();
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/v2/payments/captures/${encodeURIComponent(providerTransactionId)}/refund`,
        headers: {
          Authorization: `Bearer ${token}`,
          'PayPal-Request-Id': 'refund_' + providerTransactionId + '_' + Math.round(amount * 100),
        },
        body: { amount: { currency_code: currency.toUpperCase(), value: amount.toFixed(2) } },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      if (res.status >= 400) {
        const err = res.body;
        return {
          status: 'failed',
          amount,
          currency,
          error: err?.message || err?.details?.[0]?.description || `PayPal API error: HTTP ${res.status}`,
          response: err,
        };
      }

      const refund = res.body;
      const status = refund?.status === 'COMPLETED' ? 'success' : ['FAILED', 'CANCELLED'].includes(refund?.status) ? 'failed' : 'unknown';

      return {
        status,
        refundId: refund?.id,
        amount: refund?.amount?.value ? Number(refund.amount.value) : amount,
        currency: (refund?.amount?.currency_code || currency).toUpperCase(),
        response: refund,
        ...(status === 'failed' ? { error: `PayPal refund status: ${refund?.status}` } : {}),
      };
    } catch (err: any) {
      return { status: 'failed', amount, currency, error: err.message };
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
      const token = await this.getAccessToken();
      const requestId = (payload as any).idempotencyKey
        ? `bis_${appId}_${(payload as any).idempotencyKey}`
        : `bis_${appId}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/v2/checkout/orders`,
        headers: {
          Authorization: `Bearer ${token}`,
          'PayPal-Request-Id': requestId,
        },
        body: {
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: currency.toUpperCase(), value: amount.toFixed(2) } }],
          payment_source: { paypal: { vault_id: paymentToken } },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const err = res.body;
        throw new Error(err?.message || err?.details?.[0]?.description || `PayPal API error: HTTP ${res.status}`);
      }

      const order = res.body;
      const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
      const feePercent = this.config.transactionFeePercent || 0;
      const feeFlat = this.config.transactionFeeFlat || 0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      // COMPLETED: the vaulted payment_source captured immediately, money
      // moved. VOIDED: a definite, non-ambiguous failure. Anything else
      // (PAYER_ACTION_REQUIRED, PENDING, ...) is genuinely unresolved —
      // this gateway has no redirect flow to relay a payer action through.
      const status =
        order?.status === 'COMPLETED' ? 'success'
          : order?.status === 'VOIDED' ? 'failed'
            : 'unknown';

      return {
        id: capture?.id || order?.id,
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
        response: order,
        ...(status === 'failed' ? { error: `PayPal order status: ${order?.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'paypal_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no credentials are configured, or the caller
   * has no vaulted payment instrument to charge.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const captureId = 'paypal_sim_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const feePercent = this.config.transactionFeePercent || 0;
    const feeFlat = this.config.transactionFeeFlat || 0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      id: 'order_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
      status: 'COMPLETED',
      purchase_units: [{
        amount: { currency_code: currency.toUpperCase(), value: amount.toFixed(2) },
        payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { currency_code: currency.toUpperCase(), value: amount.toFixed(2) } }] },
      }],
    };

    return {
      id: captureId,
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
