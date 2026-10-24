import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Simulated-only messaging provider — deliberately, not an oversight.
 * "SignalHouse" is not a real, findable SMS/messaging vendor (confirmed
 * via WebSearch, 2026-09-08 and reconfirmed 2026-09-17): there is no
 * public API documentation to verify a real integration against, and the
 * master plan explicitly prohibits guessing a provider's contract. See
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same finding on
 * FutureSMS.
 */
export class SignalHouseProvider extends BaseProvider {
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
      detail: 'SignalHouse has no real, documented API to integrate with — this adapter only fabricates a response',
    });
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const txId = 'sh_msg_' + randomUUID().replace(/-/g, '').slice(0, 16);
    
    const cost = this.config.messageCost || 0.005;

    const responsePayload = {
      messageId: txId,
      status: 'QUEUED',
      channel: recipient.includes('@') ? 'email' : 'whatsapp',
      recipient: recipient,
      sentAt: new Date().toISOString(),
      metadata: {
        provider: 'SignalHouse',
        delivered: true
      }
    };

    return {
      id: txId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      messageType: recipient.includes('@') ? 'email' : 'whatsapp',
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload
    };
  }
}
