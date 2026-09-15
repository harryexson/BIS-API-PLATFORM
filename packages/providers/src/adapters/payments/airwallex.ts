import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Real Airwallex payment provider adapter.
 *
 * Uses Airwallex's PaymentIntents API — a three-call flow, unlike every
 * other adapter in this package:
 *   1. POST /api/v1/authentication/login (x-client-id/x-api-key headers)
 *      to obtain a short-lived (30 min) Bearer token. Airwallex's own
 *      docs say not to call this before every request but to cache and
 *      reuse the token — done here with a simple in-memory cache on the
 *      adapter instance, refreshed a minute before expiry.
 *   2. POST /api/v1/pa/payment_intents/create (amount, currency, an
 *      idempotency request_id, a merchant_order_id).
 *   3. POST /api/v1/pa/payment_intents/{id}/confirm to actually attempt
 *      the charge against a specific payment instrument.
 * Facts below (endpoints, auth flow, request/response shape, error
 * envelope) were verified via web search against Airwallex's public API
 * reference on 2026-09-15 (this environment's outbound network access to
 * airwallex.com is restricted — see docs/IMPLEMENTATION_BASELINE.md §6
 * item 1 for the same constraint on other adapters), not a live account.
 *
 * Like Stripe, Airwallex confirms a PaymentIntent against a specific,
 * already-tokenized instrument rather than raw card data — this
 * platform's PaymentRequest.paymentToken is used here as Airwallex's
 * `payment_consent_id` (a saved, reusable payment method reference),
 * which Airwallex's confirm step also requires a `customer_id`
 * alongside — read from `payload.metadata.airwallexCustomerId`. Without
 * both, there is no valid confirm call to make, so this adapter falls
 * back to simulated processing, same pattern as every other real
 * adapter here. Not built: relaying a `next_action` (e.g. 3D Secure)
 * back to a customer for confirmation — a REQUIRES_CUSTOMER_ACTION
 * result is reported as this platform's 'unknown' outcome rather than
 * either fabricated extreme, but there is no flow here to actually
 * resolve it.
 *
 * Environment variables:
 *   AIRWALLEX_CLIENT_ID — x-client-id
 *   AIRWALLEX_API_KEY   — x-api-key
 */
export class AirwallexProvider extends BaseProvider {
  private baseUrl = 'https://api.airwallex.com';
  private cachedToken: { token: string; expiresAtMs: number } | undefined;

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get clientId(): string {
    return this.secrets.client_id || process.env.AIRWALLEX_CLIENT_ID || '';
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.AIRWALLEX_API_KEY || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.clientId) && Boolean(this.apiKey);
  }

  // Reuses a cached token until ~1 minute before it expires, per
  // Airwallex's own guidance against calling /login on every request.
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - now > 60_000) {
      return this.cachedToken.token;
    }

    const res = await this.http_request({
      method: 'POST',
      url: `${this.baseUrl}/api/v1/authentication/login`,
      headers: {
        'x-client-id': this.clientId,
        'x-api-key': this.apiKey,
      },
      maxAttempts: 1,
    });

    if (res.status >= 400 || !res.body?.token) {
      throw new Error(res.body?.message || `Airwallex authentication failed: HTTP ${res.status}`);
    }

    const expiresAtMs = res.body.expires_at ? Date.parse(res.body.expires_at) : now + 25 * 60_000;
    this.cachedToken = { token: res.body.token, expiresAtMs };
    return res.body.token;
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const customerId = payload.metadata?.airwallexCustomerId as string | undefined;
    const startTime = Date.now();

    if (!this.clientId || !this.apiKey || !paymentToken || !customerId) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const token = await this.getAccessToken();
      const requestId = (payload as any).idempotencyKey || randomUUID();
      const orderId = `bis_${appId}_${requestId}`.slice(0, 64);

      const createRes = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/api/v1/pa/payment_intents/create`,
        headers: { Authorization: `Bearer ${token}` },
        body: {
          request_id: requestId,
          amount,
          currency: currency.toUpperCase(),
          merchant_order_id: orderId,
        },
      });

      if (createRes.status >= 400) {
        throw new Error(createRes.body?.message || `Airwallex create-intent error: HTTP ${createRes.status}`);
      }

      const intentId = createRes.body?.id;
      if (!intentId) {
        throw new Error('Airwallex create-intent response did not include an id');
      }

      const confirmRes = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/api/v1/pa/payment_intents/${intentId}/confirm`,
        headers: { Authorization: `Bearer ${token}` },
        body: {
          request_id: randomUUID(),
          customer_id: customerId,
          payment_consent_id: paymentToken,
        },
      });

      const latency = Date.now() - startTime;

      if (confirmRes.status >= 400) {
        throw new Error(confirmRes.body?.message || `Airwallex confirm error: HTTP ${confirmRes.status}`);
      }

      const intent = confirmRes.body;
      // SUCCEEDED: money moved. PENDING/REQUIRES_CUSTOMER_ACTION: genuinely
      // unresolved (e.g. a 3DS challenge this adapter has no flow to
      // relay) — not a failure. Everything else Airwallex could return
      // synchronously here (REQUIRES_PAYMENT_METHOD, CANCELLED, EXPIRED)
      // is a definite, non-ambiguous failure.
      const status =
        intent.status === 'SUCCEEDED' ? 'success' : intent.status === 'PENDING' || intent.status === 'REQUIRES_CUSTOMER_ACTION' ? 'unknown' : 'failed';

      const feePercent = this.config.transactionFeePercent || 2.0;
      const cost = status === 'success' ? (amount * feePercent) / 100 : 0;

      return {
        id: intent.id || intentId,
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
        ...(status === 'failed' ? { error: intent.message || `Airwallex status: ${intent.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'awx_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when credentials, a paymentToken, or a customer id
   * aren't all configured. Used for development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'evt_' + randomUUID().replace(/-/g, '').slice(0, 24);

    const feePercent = this.config.transactionFeePercent || 2.0;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      id: txId,
      amount,
      currency,
      status: 'SUCCEEDED',
      payment_method: {
        type: 'card',
        card: {
          brand: 'mastercard',
          last4: '9901',
        },
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
    };
  }
}
