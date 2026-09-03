import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Paystack payment provider adapter (Nigeria / African expansion corridor).
 *
 * Uses the Paystack Transaction API (https://api.paystack.co/transaction/initialize).
 * Paystack's charge flow is redirect-based (it returns an authorization_url
 * rather than an immediate charge result), which this adapter surfaces as a
 * "success" once the transaction is initialized — final settlement status
 * arrives via the charge.success webhook, same as Stripe's async webhook path.
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

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'NGN' } = payload;
    const startTime = Date.now();

    if (!this.apiKey) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const reference = `bis_${appId}_${Date.now()}`;
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/transaction/initialize`,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: {
          email: `${appId}@bis-platform.invalid`,
          amount: Math.round(amount * 100), // kobo
          currency: currency.toUpperCase(),
          reference,
          metadata: { appId, decisionReason },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (!res.body?.status) {
        throw new Error(`Paystack API error: ${res.status} - ${res.body?.message || JSON.stringify(res.body)}`);
      }

      const data = res.body.data;
      const feePercent = this.config.transactionFeePercent || 1.5;
      const feeFlat = this.config.transactionFeeFlat || 0.0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      return {
        id: data.reference,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        // Initializing a transaction only creates the checkout session — it
        // does not confirm the customer has actually paid. Real settlement
        // arrives later via the charge.success webhook, same as Stripe's
        // async confirmation path.
        status: 'pending',
        amount,
        currency,
        latency,
        cost,
        decisionReason,
        payload,
        response: data,
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

  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    const { amount = 10, currency = 'NGN' } = payload;
    const reference = `bis_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const feePercent = this.config.transactionFeePercent || 1.5;
    const feeFlat = this.config.transactionFeeFlat || 0.0;
    const cost = (amount * feePercent) / 100 + feeFlat;

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
      response: {
        reference,
        access_code: randomUUID().replace(/-/g, '').slice(0, 12),
        authorization_url: `https://checkout.paystack.com/${reference}`,
      },
    };
  }
}
