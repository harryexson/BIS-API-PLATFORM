import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

export class EmailProvider extends BaseProvider {
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
      detail: "this adapter has no real SMTP/email API integration — it only fabricates an SMTP '250 2.0.0 OK' response",
    });
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { recipient = 'user@example.com', subject = 'Notification', content = 'Hello' } = payload;
    const txId = 'email-' + randomUUID().replace(/-/g, '').slice(0, 20);
    
    const cost = this.config.messageCost || 0.0001;

    const responsePayload = {
      messageId: '<' + txId + '@bis-platform.mail>',
      accepted: [recipient],
      rejected: [],
      envelopeTime: Math.floor(latency / 3),
      messageTime: Math.floor((latency * 2) / 3),
      response: '250 2.0.0 OK: Message accepted for delivery'
    };

    return {
      id: txId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      messageType: 'email',
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload
    };
  }
}
