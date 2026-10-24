import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Checkout.com payment provider adapter.
 *
 * Uses the Checkout.com Payments API (https://api.checkout.com/payments),
 * charging the caller's tokenized card (`paymentToken`, a Checkout.com
 * `tok_...` from Frames/Flow) as `source: { type: 'token' }`. Previously
 * this charged a hardcoded `tok_test` regardless of the request (the
 * gateway never forwarded a token at all — gap register C1/E8); with no
 * `paymentToken` it now falls back to simulated processing outside
 * production and refuses (throws) in production, same as Stripe.
 *
 * Idempotency: `Cko-Idempotency-Key` header and the body `reference` both
 * carry the deterministic identity bis_<payment_transaction_id>_<client
 * key | 'default'> (see BaseProvider.buildIdempotencyIdentity) — previously
 * both were `bis_<appId>_<Date.now()>`, which never deduplicated anything
 * (gap register E7). Capped at 80 chars, believed to be Checkout.com's
 * `reference` limit — NOT confirmed against current documentation in Phase
 * 27 (no public source stating the limit for either field could be
 * reached); the header uses the same value. Checkout.com's idempotency
 * page does confirm: keys expire after 24 hours, concurrent requests with
 * one key get 409, and only SUCCESSFUL results are replayed (a 4xx/5xx is
 * not saved, so a retry is processed again).
 *
 * Environment variables:
 *   CHECKOUT_SECRET_KEY — sk_sbox_... (sandbox) or sk_... (live)
 *   CHECKOUT_API_PREFIX — optional: this account's merchant-specific base
 *     URL prefix (the first 8 characters of the environment's client_id,
 *     without `cli_`; shown on the Dashboard's Developer overview page).
 *
 * Authentication (Phase 27): Checkout.com's API-keys documentation says to
 * send a secret key "in the Authorization header with the Bearer prefix",
 * and its official Node SDK (checkout/checkout-sdk-node, test/config:
 * "should append the Bearer prefix for sandbox NAS secret keys") turns
 * `sk_sbox_...` into `Bearer sk_sbox_...`. Only previous-platform (ABC)
 * keys — `sk_<uuid>` / `sk_test_<uuid>` — go out verbatim (the same SDK's
 * PREVIOUS_SECRET_KEY_REGEX). This adapter used to send EVERY key
 * verbatim, i.e. without `Bearer` for the very `sk_sbox_`/`sk_` keys this
 * file documents.
 *
 * Host (gap register E11): environment 'test' → the sandbox host,
 * otherwise production. With CHECKOUT_API_PREFIX set (Phase 27) the host is
 * the merchant-specific `https://{prefix}.api[.sandbox].checkout.com` —
 * Checkout.com's support article "Migrate to unique API base URLs" says
 * accounts on the shared hosts must migrate, and its SDK now refuses to
 * build a client for a non-ABC key without that subdomain. Without a
 * prefix the legacy SHARED hosts `api[.sandbox].checkout.com` are still
 * used (no sunset date was found), so existing configurations keep
 * working. A malformed prefix (not lowercase alphanumeric) is treated as
 * a configuration error, never silently replaced by the shared host.
 */
const PREVIOUS_PLATFORM_SECRET_KEY = /^sk_(test_)?\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/;
const API_PREFIX_PATTERN = /^[a-z0-9]{1,32}$/;

export class CheckoutComProvider extends BaseProvider {
  private get baseUrl(): string {
    const sandbox = this.config.environment === 'test';
    const prefix = this.apiPrefix;
    if (prefix) return `https://${prefix}.api${sandbox ? '.sandbox' : ''}.checkout.com`;
    return sandbox ? 'https://api.sandbox.checkout.com' : 'https://api.checkout.com';
  }

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.CHECKOUT_SECRET_KEY || '';
  }

  private get apiPrefix(): string {
    return (this.secrets.api_prefix || process.env.CHECKOUT_API_PREFIX || '').trim();
  }

  private get apiPrefixInvalid(): boolean {
    return Boolean(this.apiPrefix) && !API_PREFIX_PATTERN.test(this.apiPrefix);
  }

  /** `Bearer <key>` for current-platform keys; previous-platform (ABC) keys verbatim. */
  private get authorizationHeader(): string {
    const key = this.apiKey;
    if (/^bearer /i.test(key) || PREVIOUS_PLATFORM_SECRET_KEY.test(key)) return key;
    return `Bearer ${key}`;
  }

  // Previously inherited BaseProvider's unconditional `true` (gap register E2).
  public isConfigured(): boolean {
    return Boolean(this.apiKey) && !this.apiPrefixInvalid;
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    if (!this.apiKey || !paymentToken || this.apiPrefixInvalid) {
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: [
          ...(this.apiKey ? [] : ['CHECKOUT_SECRET_KEY']),
          ...(this.apiPrefixInvalid ? ['CHECKOUT_API_PREFIX (malformed: lowercase letters/digits only)'] : []),
        ],
        missingInputs: paymentToken ? [] : ['paymentToken'],
      });
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    const idempotencyKey = this.paymentIdempotencyIdentity(payload, { maxLength: 80 });

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payments`,
        headers: {
          Authorization: this.authorizationHeader,
          'Cko-Idempotency-Key': idempotencyKey,
        },
        body: {
          source: { type: 'token', token: paymentToken },
          amount: Math.round(amount * 100),
          currency: currency.toUpperCase(),
          capture: true,
          reference: idempotencyKey,
          metadata: { appId, decisionReason },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
        // Cko-Idempotency-Key: Checkout.com returns the original payment for
        // a repeated key — retrying an ambiguous attempt cannot charge twice.
        retryAmbiguous: true,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        // 401 / 422 (invalid request, error_codes[]) / 429 are rejected
        // before processing (definite); 409 (idempotency conflict) and 5xx
        // (e.g. 502) are ambiguous — the generic rule.
        throw this.httpErrorOutcome(res, `Checkout.com API error: ${res.status} - ${JSON.stringify(res.body)}`);
      }

      const payment = res.body;
      if (!payment || typeof payment !== 'object') {
        throw this.ambiguousOutcome(`Checkout.com returned HTTP ${res.status} with an unreadable body`, res.status);
      }
      // Checkout.com's documented outcomes for POST /payments: 201 with
      // approved:true (Authorized/Captured) — money moving; 201 with
      // approved:false / status 'Declined' — a definite decline
      // (response_code/response_summary say why); 202 status 'Pending'
      // (3DS / async) — unresolved. It used to map everything that was not
      // approved — including 'Pending' — to 'failed', which the router
      // failed over while the original payment could still complete.
      const status: 'success' | 'failed' | 'unknown' =
        payment.status === 'Pending' ? 'unknown'
          : payment.approved === true || payment.status === 'Authorized' || payment.status === 'Captured' ? 'success'
            : payment.approved === false || payment.status === 'Declined' ? 'failed'
              : 'unknown';
      const feePercent = this.config.transactionFeePercent || 2.6;
      const feeFlat = this.config.transactionFeeFlat || 0.25;
      const cost = (amount * feePercent) / 100 + feeFlat;

      return {
        id: payment.id,
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
        response: payment,
        ...(status === 'failed'
          ? { error: payment.response_summary || `Checkout.com payment status: ${payment.status}${payment.response_code ? ` (${payment.response_code})` : ''}` }
          : {}),
      };
    } catch (err: any) {
      return this.paymentFailureEvent({ appId, payload, decisionReason, err, startTime, amount, currency, idPrefix: 'err_' });
    }
  }

  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    const { amount = 10, currency = 'USD' } = payload;
    const paymentId = 'pay_' + randomUUID().replace(/-/g, '').slice(0, 26);

    const feePercent = this.config.transactionFeePercent || 2.6;
    const feeFlat = this.config.transactionFeeFlat || 0.25;
    const cost = (amount * feePercent) / 100 + feeFlat;

    return {
      id: paymentId,
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
      response: {
        id: paymentId,
        status: 'Authorized',
        approved: true,
        amount: Math.round(amount * 100),
        currency: currency.toUpperCase(),
        response_summary: 'Approved',
      },
    };
  }
}
