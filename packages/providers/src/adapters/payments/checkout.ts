import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Checkout.com payment provider adapter.
 *
 * Uses the Checkout.com Payments API (https://api.checkout.com/payments),
 * charging against a tokenized test source since no real card-collection
 * flow sits upstream of this adapter yet.
 *
 * Environment variables:
 *   CHECKOUT_SECRET_KEY — sk_sbox_... (sandbox) or sk_... (live)
 */
export class CheckoutComProvider extends BaseProvider {
  private baseUrl = 'https://api.checkout.com';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.CHECKOUT_SECRET_KEY || '';
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD' } = payload;
    const startTime = Date.now();

    if (!this.apiKey) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const idempotencyKey = `bis_${appId}_${Date.now()}`;
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/payments`,
        headers: {
          Authorization: this.apiKey,
          'Cko-Idempotency-Key': idempotencyKey,
        },
        body: {
          // Checkout.com's sandbox test token for a Visa test card.
          source: { type: 'token', token: 'tok_test' },
          amount: Math.round(amount * 100),
          currency: currency.toUpperCase(),
          capture: true,
          reference: `bis_${appId}_${Date.now()}`,
          metadata: { appId, decisionReason },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        throw new Error(`Checkout.com API error: ${res.status} - ${JSON.stringify(res.body)}`);
      }

      const payment = res.body;
      const feePercent = this.config.transactionFeePercent || 2.6;
      const feeFlat = this.config.transactionFeeFlat || 0.25;
      const cost = (amount * feePercent) / 100 + feeFlat;

      return {
        id: payment.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status: payment.approved || payment.status === 'Authorized' ? 'success' : 'failed',
        amount,
        currency,
        latency,
        cost,
        decisionReason,
        payload,
        response: payment,
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
