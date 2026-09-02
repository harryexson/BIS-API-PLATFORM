import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

export class AirwallexProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'evt_' + randomUUID().replace(/-/g, '').slice(0, 24);
    
    const feePercent = this.config.transactionFeePercent || 2.0;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      id: 'int_' + randomUUID().replace(/-/g, '').slice(0, 16),
      payment_intent_id: txId,
      amount,
      currency,
      status: 'SUCCEEDED',
      payment_method: {
        type: 'card',
        card: {
          brand: 'mastercard',
          last4: '9901'
        }
      },
      charges: [
        {
          id: 'chg_' + randomUUID().replace(/-/g, '').slice(0, 16),
          status: 'CAPTURED',
          amount,
          currency,
          captured: true
        }
      ]
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
      response: responsePayload
    };
  }
}
