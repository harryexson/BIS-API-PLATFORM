import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class FlutterwaveProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'NGN', paymentMethod = 'card' } = payload;
    const txId = 'flw-tx-' + Math.random().toString(36).substring(2, 10).toUpperCase();

    const isLocal = ['NGN', 'GHS', 'KES'].includes(currency);
    const feePercent = isLocal ? 1.4 : 3.8;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      status: 'success',
      message: 'Tx successful',
      data: {
        id: Math.floor(Math.random() * 100000),
        tx_ref: 'flw-' + Math.random().toString(36).substring(2, 12),
        flw_ref: txId,
        device_fingerprint: 'device_fp_' + Math.random().toString(36).substring(2, 6),
        amount,
        currency,
        charged_amount: amount,
        app_fee: cost,
        merchant_fee: 0,
        processor_response: 'Approved',
        payment_type: paymentMethod,
        card: {
          first_6digits: '418742',
          last_4digits: '1111',
          issuer: 'Access Bank',
          country: 'NG',
          type: 'VISA'
        }
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
