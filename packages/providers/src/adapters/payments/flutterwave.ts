import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

export class FlutterwaveProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { amount = 10, currency = 'NGN', paymentMethod = 'card' } = payload;
    const txId = 'flw-tx-' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();

    const isLocal = ['NGN', 'GHS', 'KES'].includes(currency);
    const feePercent = isLocal ? 1.4 : 3.8;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      status: 'success',
      message: 'Tx successful',
      data: {
        id: randomUUID().replace(/-/g, '').slice(0, 10),
        tx_ref: 'flw-' + randomUUID().replace(/-/g, '').slice(0, 12),
        flw_ref: txId,
        device_fingerprint: 'device_fp_' + randomUUID().replace(/-/g, '').slice(0, 6),
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
