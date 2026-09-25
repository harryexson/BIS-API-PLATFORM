import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

/**
 * Real Checkout.com payment provider adapter (their current "NAS"
 * Unified Payments API — the Payments API, not the older/deprecated
 * Previous Platform). Facts below (base URL shape, auth, request/response
 * fields, refund semantics, webhook signature scheme) were verified via
 * web search against Checkout.com's public API documentation on
 * 2026-09-25 (this environment's outbound network access to
 * checkout.com/api-reference.checkout.com is restricted — see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint on
 * other adapters), not a live account. Treat as "built from real, current
 * documentation" rather than "certified against a live sandbox."
 *
 * **Merchant-Specific Sub-Domain (MSSD) base URL** — a real, documented
 * structural quirk unique to this adapter among this package's payment
 * providers: every request must go to a per-merchant subdomain,
 * `https://{prefix}.api.checkout.com` (live) or
 * `https://{prefix}.api.sandbox.checkout.com` (sandbox), where `prefix`
 * is the first 8 characters of the merchant's `client_id` (visible in the
 * Dashboard under Account details) with any `cli_` prefix stripped. A
 * request to the bare `api.checkout.com` host is rejected outright
 * (`403`, `error_type: base_url_invalid`) — there is no shared fallback
 * host the way Adyen's test API has one. Unlike Adyen's *optional*
 * live-only prefix, this one is required in *both* environments and is
 * mechanically derived from the client id rather than admin-typed, so
 * this adapter computes it rather than asking for it separately.
 *
 * Auth is `Authorization: Bearer {secret_key}` (the NAS platform's
 * current scheme — Checkout.com's older Previous Platform used the
 * secret key bare with no `Bearer` prefix, but that platform is not what
 * new integrations use and isn't what this adapter targets).
 *
 * Like Stripe/NMI/Adyen/Braintree, `PaymentRequest` never collects raw
 * card data — `paymentToken` must be a pre-tokenized instrument, sent as
 * `source: { type: 'token', token: paymentToken }` (Checkout.com's
 * single-use card-token source type, the closest real match to this
 * platform's generic `paymentToken` field — as opposed to `type: 'id'`,
 * which addresses a *stored* payment instrument this platform never
 * creates). `capture: true` requests immediate capture rather than a
 * separate authorize/capture step this platform has no second call for.
 * Without an API key/client id or a `paymentToken`, this adapter falls
 * back to simulated processing — never a real call with nothing to
 * charge.
 *
 * Response `status` is confirmed real for `Authorized` (treated as this
 * platform's charge success, the same "approved, funds moving" contract
 * every other adapter uses), `Declined` (failed, with `response_summary`
 * as the error), and `Pending` (3DS-redirect payments — 'unknown', never
 * fabricated either way since this platform has no redirect flow to
 * complete it). Any other status reports 'unknown' rather than guessed.
 * The error envelope for a rejected request (422 `request_invalid`, or
 * other 4xx) is `{ request_id, error_type, error_codes: [...] }` — no
 * single human-readable message field, so this adapter surfaces
 * `error_codes[0]` (falling back to `error_type`) as the error string.
 *
 * **Refunds are asynchronous and the API response does not confirm the
 * outcome** — Checkout.com's own documentation states this explicitly: a
 * successful `POST /payments/{id}/refunds` call returns `202` with only
 * `{ action_id, reference }`, and the real result arrives later via the
 * `payment_refunded`/`payment_refund_declined` webhook events. This
 * adapter therefore reports a successfully *submitted* refund as
 * `'unknown'`, never a fabricated `'success'` — the same asynchronous-
 * refund pattern already used for Adyen and (partially) Braintree here.
 *
 * **Webhook signature verification is implemented** (unlike Adyen's,
 * deliberately left unverified there due to that scheme's real
 * complexity): Checkout.com's real scheme is a plain
 * `HMAC-SHA256(raw_body, workflow_signing_key)` hex digest in the
 * `Cko-Signature` header — structurally identical to this platform's own
 * generic webhook check, just keyed by Checkout.com's own secret. Reuses
 * `BaseProvider.verifyWebhookSignature()` exactly as PayChangu's adapter
 * does.
 *
 * Environment variables:
 *   CHECKOUT_SECRET_KEY          — secret API key, sent as Bearer auth
 *   CHECKOUT_CLIENT_ID           — used only to derive the MSSD base URL
 *   CHECKOUT_WEBHOOK_SIGNING_KEY — the workflow's webhook signing key,
 *     used only by verifyProviderWebhookSignature() below
 */
export class CheckoutComProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get secretKey(): string {
    return this.secrets.secret_key || process.env.CHECKOUT_SECRET_KEY || '';
  }

  private get clientId(): string {
    return this.secrets.client_id || process.env.CHECKOUT_CLIENT_ID || '';
  }

  private get webhookSigningKey(): string {
    return this.secrets.webhook_signing_key || process.env.CHECKOUT_WEBHOOK_SIGNING_KEY || '';
  }

  private get subdomainPrefix(): string {
    return this.clientId.replace(/^cli_/, '').slice(0, 8);
  }

  private get baseUrl(): string {
    const host = this.config.environment === 'live' ? 'api.checkout.com' : 'api.sandbox.checkout.com';
    return `https://${this.subdomainPrefix}.${host}`;
  }

  public isConfigured(): boolean {
    return Boolean(this.secretKey && this.clientId);
  }

  /**
   * Verifies Checkout.com's real `Cko-Signature` header: a plain
   * HMAC-SHA256(raw body, workflow signing key) hex digest — verified via
   * WebSearch, 2026-09-25.
   */
  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.webhookSigningKey;
    if (!secret) return null;

    const header = headers['cko-signature'];
    if (!header) return false;

    return this.verifyWebhookSignature(rawBody, header, secret);
  }

  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.isConfigured()) {
      return {
        status: 'success',
        refundId: 'checkout_refund_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, paymentId: providerTransactionId },
      };
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payments/${providerTransactionId}/refunds`,
        headers: { Authorization: `Bearer ${this.secretKey}` },
        body: { amount: toMinorUnits(amount) },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      if (res.status >= 400) {
        const message = res.body?.error_codes?.[0] || res.body?.error_type || `Checkout.com API error: HTTP ${res.status}`;
        return { status: 'failed', amount, currency, error: message, response: res.body };
      }

      // 202 Accepted only means the refund request was submitted — the
      // real outcome arrives later via webhook, so this is never a
      // fabricated success.
      return {
        status: 'unknown',
        refundId: res.body?.action_id,
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

    if (!this.isConfigured() || !paymentToken) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payments`,
        headers: { Authorization: `Bearer ${this.secretKey}` },
        body: {
          source: { type: 'token', token: paymentToken },
          amount: toMinorUnits(amount),
          currency: currency.toUpperCase(),
          capture: true,
          reference: `${appId}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        },
        timeoutMs: 30_000,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const message = res.body?.error_codes?.[0] || res.body?.error_type || `Checkout.com API error: HTTP ${res.status}`;
        throw new Error(message);
      }

      const status =
        res.body?.status === 'Authorized' ? 'success'
          : res.body?.status === 'Declined' ? 'failed'
            : 'unknown';

      const feePercent = this.config.transactionFeePercent || 0;
      const feeFlat = this.config.transactionFeeFlat || 0;
      const cost = status === 'success' ? (amount * feePercent) / 100 + feeFlat : 0;

      return {
        id: res.body?.id,
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
        response: res.body,
        ...(status === 'failed' ? { error: res.body?.response_summary || `Checkout.com status: ${res.body?.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'checkout_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * has no tokenized payment instrument to charge.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'pay_sim_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const feePercent = this.config.transactionFeePercent || 0;
    const feeFlat = this.config.transactionFeeFlat || 0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      id: txId,
      status: 'Authorized',
      response_summary: 'Approved',
      amount: toMinorUnits(amount),
      currency: currency.toUpperCase(),
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

// Checkout.com amounts are in minor units (e.g. cents), like Stripe/Adyen
// — not the decimal-string convention Braintree's GraphQL API uses.
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
