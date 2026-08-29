import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real SMS provider adapter using a generic HTTP API.
 *
 * This adapter demonstrates how to build a real SMS provider integration.
 * Replace the URL and auth headers with your actual provider's API.
 *
 * Environment variables:
 *   SMS_API_KEY — API key for the SMS provider
 *   SMS_API_URL — Base URL for the SMS provider API
 */
export class SmsProvider extends BaseProvider {
  private apiUrl: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.apiUrl = this.secrets.api_url || process.env.SMS_API_URL || 'https://api.example.com/v1';
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.SMS_API_KEY || '';
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '', content = '' } = payload;
    const startTime = Date.now();

    // If no API key, fall back to simulated mode
    if (!this.apiKey) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.apiUrl}/messages`,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: {
          to: recipient,
          from: this.secrets.sender_id || 'BIS',
          body: content,
          appId,
        },
        timeoutMs: 30_000,
        maxAttempts: 3,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        throw new Error(`SMS API error: ${res.status} - ${JSON.stringify(res.body)}`);
      }

      return {
        id: res.body.id || res.body.message_id || 'msg_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: 'success',
        latency,
        cost: this.config.costPerMessage || 0.0075,
        decisionReason,
        payload,
        response: res.body,
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

    const { recipient = '', content = '' } = payload;
    const msgId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 16);

    return {
      id: msgId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      latency,
      cost: this.config.costPerMessage || 0.0075,
      decisionReason,
      payload,
      response: {
        id: msgId,
        status: 'sent',
        to: recipient,
        body: content,
      },
    };
  }
}
