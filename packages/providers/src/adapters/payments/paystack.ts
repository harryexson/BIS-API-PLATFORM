import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

/**
 * Real Paystack payment provider adapter.
 *
 * Uses Paystack's Transactions API — specifically `POST
 * /transaction/charge_authorization`, the endpoint for charging a
 * previously-authorized (saved, reusable) instrument on behalf of a
 * returning customer, not the redirect-based `/transaction/initialize`
 * a fresh checkout would use. This gateway never collects raw card data
 * and has no redirect surface (see stripe.ts's class comment for the
 * same constraint this platform's adapters all share), so
 * `charge_authorization` against `PaymentRequest.paymentToken` (used
 * directly as Paystack's `authorization_code`) is the only real flow
 * that fits — the same "merchant-initiated charge against a stored
 * instrument" shape every other card adapter here already uses. Facts
 * below (endpoint, auth, request/response shape, refund endpoint,
 * webhook signature scheme) were verified via web search against
 * Paystack's public developer documentation on 2026-09-29 (this
 * environment's outbound network access to paystack.com is restricted —
 * see docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint
 * on other adapters), not a live account. Treat as "built from real,
 * current documentation" rather than "certified against a live sandbox."
 *
 * `charge_authorization` also requires the customer's `email` — a field
 * `PaymentRequest` has no first-class slot for, read from
 * `payload.metadata.email` (the same convention flutterwave.ts and
 * paychangu.ts already use for their own gateway-specific required
 * fields). Without an API key, a `paymentToken`, or an email, this
 * adapter falls back to simulated processing — never a real call with
 * an incomplete/fabricated request.
 *
 * Amounts are in the currency's smallest subunit (kobo for NGN, pesewas
 * for GHS, cents for USD/ZAR, etc.) — the same minor-unit convention
 * Stripe/Adyen/Checkout.com already use here, applied via a flat ×100
 * (this platform's supported currencies for Paystack — NGN/GHS/ZAR/KES —
 * all use a 2-decimal subunit, so this doesn't need the exponent table a
 * fully general implementation would).
 *
 * The response envelope has two status layers: the top-level `status`
 * (boolean — whether the *API call itself* succeeded) and `data.status`
 * (string — the real transaction outcome: `'success'`, `'failed'`, or
 * others like `'abandoned'`/`'pending'` for channels needing further
 * action). Only `data.status === 'success'` is this platform's charge
 * success; `'failed'` is a definite decline (`data.gateway_response` as
 * the error); anything else is genuinely unresolved, reported as
 * `'unknown'` rather than guessed.
 *
 * Refunds are explicitly asynchronous by Paystack's own documentation —
 * a refund moves `pending` → `processing` → `processed` (or `failed`),
 * and Paystack's docs say to track the real outcome via the
 * `refund.processed`/`refund.failed` webhooks, not the initial API
 * response. This adapter therefore reports anything other than
 * `processed`/`failed` as `'unknown'`, never a fabricated success — the
 * same asynchronous-refund pattern already used for Adyen and
 * Checkout.com here.
 *
 * Native inbound-webhook signature verification **is** implemented:
 * Paystack's real `x-paystack-signature` header is a hex-encoded
 * HMAC-SHA512 (not SHA256) of the raw request body, keyed by the same
 * secret key used for API calls (no separate webhook secret to
 * configure) — this needed its own implementation rather than reusing
 * `BaseProvider.verifyWebhookSignature()`, which is hardcoded to SHA256.
 *
 * Environment variables:
 *   PAYSTACK_SECRET_KEY — sk_test_... or sk_live_...
 */
export class PaystackProvider extends BaseProvider {
  private baseUrl = 'https://api.paystack.co';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.PAYSTACK_SECRET_KEY || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.apiKey;
    if (!secret) return null;

    const header = headers['x-paystack-signature'];
    if (!header) return false;

    const { createHmac, timingSafeEqual } = await import('crypto');
    const expected = createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(header, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.isConfigured()) {
      return {
        status: 'success',
        refundId: 'paystack_refund_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, transaction: providerTransactionId },
      };
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/refund`,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: { transaction: providerTransactionId, amount: Math.round(amount * 100) },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      if (res.status >= 400 || res.body?.status === false) {
        return { status: 'failed', amount, currency, error: res.body?.message || `Paystack API error: HTTP ${res.status}`, response: res.body };
      }

      const refund = res.body?.data;
      const status = refund?.status === 'processed' ? 'success' : refund?.status === 'failed' ? 'failed' : 'unknown';

      return {
        status,
        refundId: refund?.id ? String(refund.id) : undefined,
        amount: refund?.amount ? refund.amount / 100 : amount,
        currency: (refund?.currency || currency).toUpperCase(),
        response: refund,
        ...(status === 'failed' ? { error: `Paystack refund status: ${refund?.status}` } : {}),
      };
    } catch (err: any) {
      return { status: 'failed', amount, currency, error: err.message };
    }
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const email = payload.metadata?.email as string | undefined;
    const startTime = Date.now();

    if (!this.isConfigured() || !paymentToken || !email) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/transaction/charge_authorization`,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: {
          authorization_code: paymentToken,
          email,
          amount: Math.round(amount * 100),
          currency: currency.toUpperCase(),
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400 || res.body?.status === false) {
        throw new Error(res.body?.message || `Paystack API error: HTTP ${res.status}`);
      }

      const data = res.body?.data;
      if (!data) {
        throw new Error('Paystack charge_authorization response did not include a data object');
      }

      const feePercent = this.config.transactionFeePercent || 0;
      const feeFlat = this.config.transactionFeeFlat || 0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      // success: money moved. failed: a definite, non-ambiguous decline.
      // abandoned/pending/anything else: genuinely unresolved — some
      // channels need further action this gateway has no flow to relay.
      const status = data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : 'unknown';

      return {
        id: data.reference || String(data.id),
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
        response: data,
        ...(status === 'failed' ? { error: data.gateway_response || data.message || `Paystack transaction status: ${data.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'paystack_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * no authorization_code (paymentToken) / email to charge.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const reference = 'paystack_sim_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const feePercent = this.config.transactionFeePercent || 0;
    const feeFlat = this.config.transactionFeeFlat || 0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      status: 'success',
      reference,
      amount: Math.round(amount * 100),
      currency: currency.toUpperCase(),
      gateway_response: 'Approved',
    };

    return {
      id: reference,
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
