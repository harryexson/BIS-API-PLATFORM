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
 * resolve it. This should be rare in practice: confirming against a
 * saved `payment_consent_id` for a known `customer_id` (never a live
 * card entry) is the same real PSD2 "merchant-initiated transaction"
 * shape Adyen's adapter documents as generally SCA-exempt — see
 * adyen.ts's class comment for the fuller reasoning, reasoned through
 * (not freshly WebSearched) rather than re-derived here.
 *
 * Environment variables:
 *   AIRWALLEX_CLIENT_ID     — x-client-id
 *   AIRWALLEX_API_KEY       — x-api-key
 *   AIRWALLEX_WEBHOOK_SECRET — the notification URL's own secret key
 *     (each webhook subscription has its own, per Airwallex's docs), used
 *     only by verifyProviderWebhookSignature() below.
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

  private get webhookSecret(): string {
    return this.secrets.webhook_secret || process.env.AIRWALLEX_WEBHOOK_SECRET || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.clientId) && Boolean(this.apiKey);
  }

  /**
   * Verifies Airwallex's real `x-signature`/`x-timestamp` headers —
   * verified via WebSearch, 2026-09-17: HMAC-SHA256 of
   * `x-timestamp + raw_body` (concatenated directly, no separator),
   * keyed by the notification URL's own secret, hex-encoded.
   */
  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.webhookSecret;
    if (!secret) return null;

    const timestamp = headers['x-timestamp'];
    const signature = headers['x-signature'];
    if (!timestamp || !signature) return false;

    const { createHmac, timingSafeEqual } = await import('crypto');
    const expected = createHmac('sha256', secret).update(`${timestamp}${rawBody}`, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
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
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: [
          ...(this.clientId ? [] : ['AIRWALLEX_CLIENT_ID']),
          ...(this.apiKey ? [] : ['AIRWALLEX_API_KEY']),
        ],
        missingInputs: [...(paymentToken ? [] : ['paymentToken']), ...(customerId ? [] : ['metadata.airwallexCustomerId'])],
      });
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    // Airwallex dedupes on `request_id` (max 64 chars). Both calls get
    // deterministic ids derived from bis_<payment_transaction_id>_<client
    // key | 'default'>; create and confirm are different operations, so the
    // confirm id carries a 'confirm' suffix. `merchant_order_id` is the
    // create identity. Previously: the raw client key or a random UUID for
    // create, and an always-random UUID for confirm (gap register E7) — a
    // retried confirm could never be deduplicated.
    const requestId = this.paymentIdempotencyIdentity(payload, { maxLength: 64 });
    const confirmRequestId = this.paymentIdempotencyIdentity(payload, { maxLength: 64, suffix: 'confirm' });
    const orderId = requestId;

    // Phase 11-12 (A10/E4): the login and create-intent steps move no
    // money — a PaymentIntent is only charged by /confirm. ANY failure
    // before /confirm is sent (even an ambiguous one: at worst an orphaned,
    // never-confirmed intent exists at Airwallex) is therefore a definite
    // non-charge. Only the confirm step can be ambiguous.
    let intentId: string | undefined;
    try {
      let token: string;
      let createRes;
      try {
        token = await this.getAccessToken();
        createRes = await this.http_request({
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
      } catch (preConfirmErr: any) {
        throw this.definiteFailure(preConfirmErr?.message || String(preConfirmErr));
      }

      if (createRes.status >= 400) {
        throw this.definiteFailure(createRes.body?.message || `Airwallex create-intent error: HTTP ${createRes.status}`, createRes.status);
      }

      intentId = createRes.body?.id;
      if (!intentId) {
        throw this.definiteFailure('Airwallex create-intent response did not include an id (confirm was not attempted)');
      }

      const confirmRes = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/api/v1/pa/payment_intents/${intentId}/confirm`,
        headers: { Authorization: `Bearer ${token}` },
        body: {
          request_id: confirmRequestId,
          customer_id: customerId,
          payment_consent_id: paymentToken,
        },
        // Not relying on Airwallex replaying a repeated request_id (it is
        // documented as a uniqueness key; whether a duplicate returns the
        // original result or a rejection is not verified here). A confirm
        // that may have reached Airwallex is never re-sent.
        retryAmbiguous: false,
      });

      const latency = Date.now() - startTime;

      if (confirmRes.status >= 400) {
        const message = confirmRes.body?.message || `Airwallex confirm error: HTTP ${confirmRes.status}`;
        // A request_id duplicate rejection means an earlier confirm with this
        // id exists — whose outcome we do not have: ambiguous. Otherwise the
        // generic rule (4xx definite, 5xx ambiguous).
        if (/duplicate/i.test(String(confirmRes.body?.code ?? ''))) throw this.ambiguousOutcome(message, confirmRes.status);
        throw this.httpErrorOutcome(confirmRes, message);
      }

      const intent = confirmRes.body;
      // SUCCEEDED: money moved. REQUIRES_PAYMENT_METHOD (the confirm was
      // declined), CANCELLED, EXPIRED: definite, non-ambiguous failures.
      // Everything else — PENDING, REQUIRES_CUSTOMER_ACTION (e.g. a 3DS
      // challenge this adapter has no flow to relay), REQUIRES_CAPTURE (an
      // authorization holding funds; it used to fall through to 'failed'),
      // or a status this adapter does not recognise — is unresolved.
      const status =
        intent?.status === 'SUCCEEDED' ? 'success'
          : ['REQUIRES_PAYMENT_METHOD', 'CANCELLED', 'EXPIRED'].includes(intent?.status) ? 'failed'
            : 'unknown';

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
      // An ambiguous confirm keeps the real PaymentIntent id (known from the
      // create step) so reconciliation can look it up.
      return this.paymentFailureEvent({
        appId, payload, decisionReason, err, startTime, amount, currency,
        idPrefix: 'awx_err_',
        providerTransactionId: intentId,
      });
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
