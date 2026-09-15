import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Real PayChangu mobile-money payment provider adapter.
 *
 * Uses PayChangu's Mobile Money API
 * (POST /mobile-money/payments/initialize). Facts below (endpoint, auth,
 * request fields) were verified via web search against PayChangu's
 * public API reference on 2026-09-15 (this environment's outbound
 * network access to paychangu.com is restricted — see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint on
 * other adapters), not a live account. The response/error envelope shape
 * is a **lower-confidence** inference: PayChangu's documented success
 * shape (`{ status, message, data }`) was directly confirmed, but its
 * non-2xx error envelope was not — this adapter assumes the same
 * `{ status, message }` shape holds for errors too, matching every
 * PayChangu response search results did surface. If that assumption is
 * wrong for a given failure mode, only the error-message extraction
 * needs correcting — the endpoint, auth, and request shape are the
 * well-documented part.
 *
 * Like PawaPay (a similar mobile-money aggregator), this needs no
 * pre-tokenized card instrument — the customer approves the charge on
 * their own phone. What it does need is PayChangu's own operator
 * reference id (`mobile_money_operator_ref_id`, from PayChangu's "Get
 * Operators" endpoint) — this platform has no reliable way to derive
 * that from a phone number alone, so guessing one would just be a
 * different way of not doing real verification. Read from
 * `payload.metadata.paychanguOperatorRefId`; without it (or an API key)
 * this adapter falls back to simulated processing, same pattern as
 * PawaPay.
 *
 * As with Flutterwave, a 200 response with top-level `status: "success"`
 * only means the request was accepted — the real outcome is
 * `data.status` ('success' | 'pending' | 'failed'). 'pending' maps to
 * this platform's 'unknown' outcome, not a fabricated success or
 * failure.
 *
 * Environment variables:
 *   PAYCHANGU_API_KEY — secret key, sent as Bearer auth
 */
export class PayChanguProvider extends BaseProvider {
  private baseUrl = 'https://api.paychangu.com';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.PAYCHANGU_API_KEY || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'MWK', phoneNumber = '265990000000' } = payload;
    const operatorRefId = payload.metadata?.paychanguOperatorRefId as string | undefined;
    const startTime = Date.now();

    if (!this.apiKey || !operatorRefId) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const chargeId = (payload as any).idempotencyKey
        ? `bis_${appId}_${(payload as any).idempotencyKey}`
        : `bis_${appId}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/mobile-money/payments/initialize`,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: {
          mobile_money_operator_ref_id: operatorRefId,
          mobile: phoneNumber,
          amount,
          charge_id: chargeId,
        },
        timeoutMs: 30_000,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400 || res.body?.status === 'error' || res.body?.status === 'failed') {
        throw new Error(res.body?.message || `PayChangu API error: HTTP ${res.status}`);
      }

      const data = res.body?.data;
      if (!data) {
        throw new Error('PayChangu response did not include a data object');
      }

      // Top-level status: "success" only means the request was accepted
      // for processing — data.status is the real transaction outcome.
      const status = data.status === 'success' ? 'success' : data.status === 'pending' ? 'unknown' : 'failed';

      const feePercent = this.config.transactionFeePercent || 1.5;
      const cost = status === 'success' ? (amount * feePercent) / 100 : 0;

      return {
        id: String(data.charge_id ?? data.ref_id ?? chargeId),
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
        ...(status === 'failed' ? { error: data.message || `PayChangu data.status: ${data.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'pc_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no API key or operator reference id is
   * configured. Used for development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'MWK', phoneNumber = '265990000000' } = payload;
    const txId = 'pc-' + randomUUID().replace(/-/g, '').slice(0, 24);

    const feePercent = this.config.transactionFeePercent || 1.5;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      status: 'success',
      message: 'Charge completed',
      data: {
        id: txId,
        amount,
        charge_type: 'mobile_money',
        currency,
        reference: 'pc-ref-' + randomUUID().replace(/-/g, '').slice(0, 12),
        provider: 'Airtel Money',
        phone: phoneNumber,
        status: 'success',
        created_at: new Date().toISOString(),
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
