import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * ExampleMessagingProvider — demonstrates how to add a new messaging provider.
 *
 * To add a new messaging provider, you ONLY need to:
 * 1. Create a class extending BaseProvider
 * 2. Implement processRequest()
 * 3. Register it in ProviderRegistry with capabilities
 * 4. Configure credentials via the management API
 *
 * NO changes to routing engine, gateway, or other providers required.
 */
export class ExampleMessagingProvider extends BaseProvider {
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
      detail: 'example/demo adapter with no real provider integration',
    });
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const txId = 'ex_msg_' + randomUUID().replace(/-/g, '').slice(0, 16);

    const cost = this.config.messageCost || 0.003;

    const isEmail = recipient.includes('@');

    const responsePayload = {
      messageId: txId,
      status: 'DELIVERED',
      channel: isEmail ? 'email' : 'sms',
      recipient,
      sentAt: new Date().toISOString(),
    };

    return {
      id: txId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      messageType: isEmail ? 'email' : 'sms',
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload,
    };
  }
}
