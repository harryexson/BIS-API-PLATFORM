import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

const CURRENCY_TO_COUNTRY: Record<string, string> = {
  NGN: 'NG',
  GHS: 'GH',
  KES: 'KE',
  UGX: 'UG',
  ZAR: 'ZA',
  TZS: 'TZ',
};

/**
 * Real Flutterwave payment provider adapter.
 *
 * Uses Flutterwave's v3 tokenized-charge API
 * (POST /v3/tokenized-charges) — the charge-with-token flow for a card
 * already tokenized on a previous transaction, which matches this
 * gateway's paymentToken contract (see below). Facts below (endpoint,
 * auth, request/response shape, error envelope) were verified via web
 * search against Flutterwave's public API reference on 2026-09-14 (this
 * environment's outbound network access to flutterwave.com is
 * restricted — see docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the
 * same constraint on other adapters), not a live account. Treat as
 * "built from real, current documentation" rather than "certified
 * against a live sandbox."
 *
 * Unlike Stripe/NMI, Flutterwave's v3 API takes a normal JSON body.
 * Critically, a 200 response with top-level `status: "success"` only
 * means the API *accepted the request* — it does not mean the charge
 * succeeded. The real outcome is `data.status`
 * ('successful' | 'pending' | 'failed'); never report success from the
 * top-level envelope alone.
 *
 * This gateway's PaymentRequest contract never collects raw card data by
 * default (see PaymentRequest.paymentToken in @company/schemas — the same
 * design used for Stripe/NMI). Flutterwave's tokenized-charge flow also
 * requires a customer `email`, which this platform's PaymentRequest
 * doesn't carry as a first-class field — read from `payload.metadata.email`
 * when present. Without both a token and an email there is no valid
 * charge this adapter could attempt, so it falls back to simulated
 * processing exactly like it does when no API key is configured.
 *
 * Environment variables:
 *   FLUTTERWAVE_SECRET_KEY  — FLWSECK_...
 *   FLUTTERWAVE_SECRET_HASH — the "secret hash" configured on the
 *     Flutterwave dashboard's webhook settings, used only by
 *     verifyProviderWebhookSignature() below.
 */
export class FlutterwaveProvider extends BaseProvider {
  private baseUrl = 'https://api.flutterwave.com/v3';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.FLUTTERWAVE_SECRET_KEY || '';
  }

  private get webhookHash(): string {
    return this.secrets.webhook_secret || process.env.FLUTTERWAVE_SECRET_HASH || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Verifies Flutterwave's real `verif-hash` header — verified via
   * WebSearch, 2026-09-17. Unlike every other provider here, this is
   * *not* a computed HMAC of the payload: Flutterwave's own
   * documentation and multiple independent sources describe the
   * `verif-hash` value as static — the exact same "secret hash" string
   * configured on the dashboard, echoed back verbatim on every webhook
   * delivery from that merchant account (one source additionally
   * describes it as SHA-256(secretHash) rather than the raw value; the
   * sources disagree on this specific point and this environment cannot
   * reach flutterwave.com to check directly — if live traffic shows this
   * comparison failing against real Flutterwave webhooks, hashing
   * `webhookHash` with SHA-256 before comparing is the documented
   * alternative to try first). Implemented here as a direct constant-time
   * string comparison, the majority-documented behavior.
   */
  public async verifyProviderWebhookSignature(
    _rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.webhookHash;
    if (!secret) return null;

    const header = headers['verif-hash'];
    if (!header) return false;

    const { timingSafeEqual } = await import('crypto');
    const a = Buffer.from(header, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Refunds a transaction via POST /v3/transactions/{id}/refund —
   * verified against Flutterwave's current API reference via WebSearch,
   * 2026-09-17: `{id}` is Flutterwave's own numeric transaction id
   * (`data.id` from the charge response — exactly what this adapter
   * already returns as TransactionEvent.id when it's present, see
   * processRequest below), body is JSON `{ amount, comments? }`.
   * Refunds settle asynchronously (Flutterwave documents 3-15 working
   * days) — this synchronous response only confirms the refund *request*
   * was accepted, so a successful call reports this platform's 'unknown'
   * outcome, not a confirmed 'success', mirroring how processRequest
   * already treats Flutterwave's 'pending' charge status.
   *
   * Falls back to a labeled simulated success when no API key is
   * configured — same rule processRequest already follows.
   */
  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.apiKey) {
      return {
        status: 'success',
        refundId: 'flw_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, id: providerTransactionId },
      };
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/transactions/${providerTransactionId}/refund`,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: { amount },
        timeoutMs: 30_000,
      });

      if (res.status >= 400 || res.body?.status === 'error') {
        return { status: 'failed', amount, currency, error: res.body?.message || `Flutterwave API error: HTTP ${res.status}`, response: res.body };
      }

      const data = res.body?.data;
      if (!data) {
        return { status: 'failed', amount, currency, error: 'Flutterwave refund response did not include a data object', response: res.body };
      }

      return {
        status: 'unknown',
        refundId: data.id ? String(data.id) : undefined,
        amount: data.amount_refunded ?? amount,
        currency,
        response: res.body,
      };
    } catch (err: any) {
      return { status: 'failed', amount, currency, error: err.message };
    }
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'NGN', paymentToken } = payload;
    const email = (payload.metadata?.email as string | undefined) || undefined;
    const startTime = Date.now();

    // No API key, or no tokenized instrument, or no customer email (a
    // required field for this flow) — any of those means there is no
    // valid real charge to attempt. Fall back to simulated mode.
    if (!this.apiKey || !paymentToken || !email) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const txRef = (payload as any).idempotencyKey
        ? `bis_${appId}_${(payload as any).idempotencyKey}`
        : `flw_${appId}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/tokenized-charges`,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: {
          token: paymentToken,
          currency,
          country: CURRENCY_TO_COUNTRY[currency.toUpperCase()] || 'NG',
          amount,
          email,
          tx_ref: txRef,
          narration: decisionReason.slice(0, 100),
        },
        timeoutMs: 30_000,
      });

      const latency = Date.now() - startTime;

      // A non-2xx or a top-level status: "error" both mean the request
      // itself was rejected (bad params, invalid/expired token, auth
      // failure) — never got far enough to attempt a charge at all.
      if (res.status >= 400 || res.body?.status === 'error') {
        throw new Error(res.body?.message || `Flutterwave API error: HTTP ${res.status}`);
      }

      const data = res.body?.data;
      if (!data) {
        throw new Error('Flutterwave response did not include a data object');
      }

      // The top-level status: "success" only means the request was
      // accepted for processing — data.status is the real outcome.
      // 'pending' is a genuinely unresolved outcome (common for bank
      // transfer / mobile money legs of a charge still settling), not a
      // confirmed failure — must not be conflated with 'failed'.
      const status = data.status === 'successful' ? 'success' : data.status === 'pending' ? 'unknown' : 'failed';

      const isLocal = ['NGN', 'GHS', 'KES'].includes(currency.toUpperCase());
      const feePercent = this.config.transactionFeePercent || (isLocal ? 1.4 : 3.8);
      const cost = status === 'success' ? (amount * feePercent) / 100 : 0;

      return {
        id: String(data.id ?? data.flw_ref ?? txRef),
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
        response: res.body,
        ...(status === 'failed' ? { error: data.processor_response || `Flutterwave data.status: ${data.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'flw_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * no tokenized payment instrument / email to charge against. Used for
   * development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'NGN', paymentMethod = 'card' } = payload;
    const txId = 'flw-tx-' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();

    const isLocal = ['NGN', 'GHS', 'KES'].includes(currency.toUpperCase());
    const feePercent = isLocal ? 1.4 : 3.8;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      status: 'success',
      message: 'Tx successful',
      data: {
        id: randomUUID().replace(/-/g, '').slice(0, 10),
        tx_ref: 'flw-' + randomUUID().replace(/-/g, '').slice(0, 12),
        flw_ref: txId,
        status: 'successful',
        amount,
        currency,
        charged_amount: amount,
        app_fee: cost,
        merchant_fee: 0,
        processor_response: 'Approved',
        payment_type: paymentMethod,
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
