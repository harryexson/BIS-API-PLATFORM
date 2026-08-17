import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class PayChanguProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'MWK', phoneNumber = '265990000000' } = payload;
    const txId = 'pc-' + Math.random().toString(36).substring(2, 15);
    
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
        reference: 'pc-ref-' + Math.random().toString(36).substring(2, 8),
        provider: 'Airtel Money',
        phone: phoneNumber,
        created_at: new Date().toISOString()
      }
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
