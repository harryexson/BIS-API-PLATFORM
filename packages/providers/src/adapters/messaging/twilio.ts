import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Twilio messaging provider adapter (SMS + WhatsApp).
 *
 * Uses the Twilio Messages REST API
 * (https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json),
 * which — unlike every other provider adapter in this package — requires an
 * application/x-www-form-urlencoded body, not JSON. See base.ts's
 * http_request(): a pre-serialized string body is sent as-is instead of being
 * JSON.stringify'd again.
 *
 * Environment variables:
 *   TWILIO_ACCOUNT_SID — AC...
 *   TWILIO_AUTH_TOKEN  — Auth token
 *   TWILIO_FROM_NUMBER — E.164 sender number (or messaging service SID)
 */
export class TwilioProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get accountSid(): string {
    return this.secrets.account_sid || process.env.TWILIO_ACCOUNT_SID || '';
  }

  private get authToken(): string {
    return this.secrets.auth_token || process.env.TWILIO_AUTH_TOKEN || '';
  }

  private get fromNumber(): string {
    return this.secrets.from_number || process.env.TWILIO_FROM_NUMBER || '';
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const isWhatsApp = String(payload.channel).toLowerCase() === 'whatsapp';
    const startTime = Date.now();

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const form = new URLSearchParams({
        To: isWhatsApp ? `whatsapp:${recipient}` : recipient,
        From: isWhatsApp ? `whatsapp:${this.fromNumber}` : this.fromNumber,
        Body: content,
      });

      const basicAuth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

      const res = await this.http_request({
        method: 'POST',
        url: `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        throw new Error(`Twilio API error: ${res.status} - ${res.body?.message || JSON.stringify(res.body)}`);
      }

      const message = res.body;
      const cost = this.config.messageCost || (isWhatsApp ? 0.005 : 0.0075);

      return {
        id: message.sid,
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: ['queued', 'sending', 'sent', 'delivered', 'accepted'].includes(message.status) ? 'success' : 'failed',
        messageType: isWhatsApp ? 'whatsapp' : 'sms',
        latency,
        cost,
        decisionReason,
        payload,
        response: message,
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'err_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: 'failed',
        messageType: isWhatsApp ? 'whatsapp' : 'sms',
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: null,
        error: err.message,
      };
    }
  }

  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const isWhatsApp = String(payload.channel).toLowerCase() === 'whatsapp';
    const sid = 'SM' + randomUUID().replace(/-/g, '').slice(0, 32);
    const cost = this.config.messageCost || (isWhatsApp ? 0.005 : 0.0075);

    return {
      id: sid,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      messageType: isWhatsApp ? 'whatsapp' : 'sms',
      latency,
      cost,
      decisionReason,
      payload,
      response: {
        sid,
        to: recipient,
        status: 'queued',
        num_segments: String(Math.ceil(content.length / 160)),
      },
    };
  }
}
