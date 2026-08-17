import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class PawaPayProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'KES', phoneNumber = '254700000000' } = payload;
    const txId = 'paw-' + Math.random().toString(36).substring(2, 15);
    
    const feePercent = this.config.transactionFeePercent || 1.0;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      depositId: txId,
      status: 'COMPLETED',
      statusTimestamp: new Date().toISOString(),
      amount: amount.toString(),
      currency: currency,
      payer: {
        type: 'MSISDN',
        address: {
          value: phoneNumber
        }
      },
      paymentNetwork: phoneNumber.startsWith('254') ? 'SAFARICOM' : 'MTN',
      recipientDate: new Date().toISOString()
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
