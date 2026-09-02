import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * ExamplePaymentProvider — demonstrates how to add a new payment provider.
 *
 * To add a new payment provider, you ONLY need to:
 * 1. Create a class extending BaseProvider
 * 2. Implement processRequest()
 * 3. Register it in ProviderRegistry with capabilities
 * 4. Configure credentials via the management API
 *
 * NO changes to routing engine, gateway, or other providers required.
 */
export class ExamplePaymentProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentMethod = 'card' } = payload;
    const txId = 'ex_pay_' + randomUUID().replace(/-/g, '').slice(0, 16);

    const feePercent = this.config.transactionFeePercent || 2.5;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      id: txId,
      status: 'COMPLETED',
      amount,
      currency,
      paymentMethod,
      processedAt: new Date().toISOString(),
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
