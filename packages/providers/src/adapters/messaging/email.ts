import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

export class EmailProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
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
