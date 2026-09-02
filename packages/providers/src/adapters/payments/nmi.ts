import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

export class NMIProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'nmi_' + randomUUID().replace(/-/g, '').slice(0, 16);
    
    const feePercent = this.config.transactionFeePercent || 2.2;
    const feeFlat = this.config.transactionFeeFlat || 0.20;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      response: '1',
      responsetext: 'SUCCESS',
      authcode: randomUUID().replace(/-/g, '').slice(0, 6),
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
