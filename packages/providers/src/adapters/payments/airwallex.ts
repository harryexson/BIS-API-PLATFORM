import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class AirwallexProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'evt_' + Math.random().toString(36).substring(2, 15);
    
    const feePercent = this.config.transactionFeePercent || 2.0;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      id: 'int_' + Math.random().toString(36).substring(2, 15),
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
          id: 'chg_' + Math.random().toString(36).substring(2, 15),
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
