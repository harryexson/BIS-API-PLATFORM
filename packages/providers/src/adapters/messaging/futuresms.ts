import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Simulated-only messaging provider — deliberately, not an oversight.
 * "FutureSMS" is not a real, findable SMS vendor (confirmed via
 * WebSearch, 2026-09-17: searching for its API/developer documentation
 * surfaces only unrelated SMS gateway products, nothing matching this
 * name) — there is no public API to verify a real integration against,
 * and the master plan explicitly prohibits guessing a provider's
 * contract. See docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same
 * finding on SignalHouse.
 */
export class FutureSMSProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { recipient = '+254700000000', content = 'Hello' } = payload;
    const txId = 'fsms_' + randomUUID().replace(/-/g, '').slice(0, 12);
    
    const cost = this.config.messageCost || 0.002;

    const responsePayload = {
      success: true,
      ref_id: txId,
      recipient: recipient,
      credits_used: 1,
      network: 'MTN_DISPATCH',
      delivered_status: 'ACCEPTED'
    };

    return {
      id: txId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      messageType: 'sms',
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload
    };
  }
}
