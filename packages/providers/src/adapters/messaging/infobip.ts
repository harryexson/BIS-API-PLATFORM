import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

export class InfobipProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  /**
   * Phase 26 (gap register E2 messaging side / E3): this adapter makes no real provider call at all, so it is
   * never "configured" for real delivery. It used to inherit BaseProvider's
   * unconditional `true` while being registered — and routed — as a
   * production messaging provider.
   */
  public isConfigured(): boolean {
    return false;
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    // Phase 26 (gap register E2 messaging side / E3): production kill-switch. Every result below is fabricated
    // (no HTTP call is ever made), so with NODE_ENV=production this THROWS
    // ProviderNotConfiguredError (a definite non-send — the router fails
    // over to a real provider or reports the channel unavailable) instead of
    // reporting a message as delivered that never left the platform.
    this.refuseSimulatedFallbackInProduction({
      simulationOnly: true,
      detail: 'Infobip is a real vendor, but this adapter has no real Infobip API integration — it only fabricates an Infobip-shaped PENDING_ENROUTE response',
    });
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const txId = 'ib-' + randomUUID().replace(/-/g, '').slice(0, 8) + '-' + randomUUID().replace(/-/g, '').slice(0, 4);
    
    const cost = this.config.messageCost || 0.008;

    const responsePayload = {
      messages: [
        {
          to: recipient,
          status: {
            groupId: 1,
            groupName: 'PENDING',
            id: 7,
            name: 'PENDING_ENROUTE',
            description: 'Message sent to next network node.'
          },
          messageId: txId,
          smsCount: Math.ceil(content.length / 160)
        }
      ]
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
