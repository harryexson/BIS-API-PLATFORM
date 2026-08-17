import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class NMIProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'nmi_' + Math.floor(Math.random() * 1000000000);
    
    const feePercent = this.config.transactionFeePercent || 2.2;
    const feeFlat = this.config.transactionFeeFlat || 0.20;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      response: '1',
      responsetext: 'SUCCESS',
      authcode: Math.floor(Math.random() * 900000 + 100000).toString(),
      transactionid: txId,
      avsresponse: 'Y',
      cvvresponse: 'M',
      amount: amount.toFixed(2),
      currency: currency
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
