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
 * (gap register E7). Capped at 80 chars (Checkout.com's documented
 * `reference` limit; the header uses the same value).
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

  // Previously inherited BaseProvider's unconditional `true` (gap register E2).
  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    if (!this.apiKey || !paymentToken) {
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: this.apiKey ? [] : ['CHECKOUT_SECRET_KEY'],
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
          Authorization: this.apiKey,
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
