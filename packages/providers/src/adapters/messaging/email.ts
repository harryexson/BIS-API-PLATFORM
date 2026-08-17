import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class EmailProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { recipient = 'user@example.com', subject = 'Notification', content = 'Hello' } = payload;
    const txId = 'email-' + Math.random().toString(36).substring(2, 15);
    
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
