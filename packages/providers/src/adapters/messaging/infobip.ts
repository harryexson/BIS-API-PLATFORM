import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real Infobip SMS provider adapter.
 *
 * Uses Infobip's SMS API v3 (POST /sms/3/messages) with automatic retry on
 * 429/5xx (via BaseProvider.http_request) and a configurable timeout.
 *
 * Facts below (endpoint, auth header format, request/response shape, error
 * envelope, status groups) were verified via web search against Infobip's
 * public documentation on 2026-09-08 — search snippets, not a directly
 * fetched page (this environment's outbound network access is restricted;
 * see docs/IMPLEMENTATION_BASELINE.md §6 item 1). Not yet verified against
 * a live Infobip account — no credentials were available in this session.
 * Treat as "built from real, current documentation" rather than
 * "certified against a live sandbox."
 *
 * Environment variables:
 *   INFOBIP_API_KEY  — used as `Authorization: App <key>`
 *   INFOBIP_BASE_URL — account-specific, format like "xxxxx.api.infobip.com"
 *                      (Infobip routes each account through its own base
 *                      URL — see https://www.infobip.com/docs/essentials/api-essentials/base-url)
 */

interface InfobipMessageStatus {
  groupId: number;
  groupName: string; // 'PENDING' | 'DELIVERED' | 'UNDELIVERED' | 'EXPIRED' | 'REJECTED'
  id: number;
  name: string;
  description: string;
}

interface InfobipSendResponseMessage {
  to: string;
  status: InfobipMessageStatus;
  messageId: string;
  smsCount?: number;
}

interface InfobipSendResponse {
  bulkId: string;
  messages: InfobipSendResponseMessage[];
}

interface InfobipErrorResponse {
  requestError?: {
    serviceException?: {
      messageId?: string;
      text?: string;
    };
  };
}

export class InfobipProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.INFOBIP_API_KEY || '';
  }

  private get baseUrl(): string {
    const raw = this.secrets.base_url || process.env.INFOBIP_BASE_URL || '';
    return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const startTime = Date.now();

    // No API key or base URL configured — fall back to simulated mode.
    // Matches the established pattern in adapters/payments/stripe.ts: the
    // platform must keep working in dev/test without real credentials, and
    // every existing test relies on that.
    if (!this.apiKey || !this.baseUrl) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `https://${this.baseUrl}/sms/3/messages`,
        headers: {
          Authorization: `App ${this.apiKey}`,
          Accept: 'application/json',
        },
        body: {
          messages: [
            {
              sender: (payload as any).from || this.config.name,
              destinations: [{ to: recipient }],
              content: { text: content },
            },
          ],
        },
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const errBody = res.body as InfobipErrorResponse;
        const errorText =
          errBody?.requestError?.serviceException?.text ||
          `Infobip API error: HTTP ${res.status}`;
        throw new Error(errorText);
      }

      const body = res.body as InfobipSendResponse;
      const message = body?.messages?.[0];
      if (!message) {
        throw new Error('Infobip response did not include a message result');
      }

      // A 2xx HTTP response can still carry a REJECTED status per-message —
      // the API accepted the *request* but rejected the *message* (e.g. an
      // invalid destination). Only report success when Infobip actually
      // accepted the message for delivery — never fabricate acceptance.
      // PENDING/DELIVERED here means "accepted for processing," not "the
      // handset has received it" — that confirmation arrives later via a
      // delivery report webhook, not this response.
      const rejected = message.status?.groupName === 'REJECTED';

      return {
        id: message.messageId,
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: rejected ? 'failed' : 'success',
        messageType: 'sms',
        latency,
        cost: this.config.messageCost || 0.008,
        decisionReason,
        payload,
        response: body,
        ...(rejected ? { error: message.status?.description || 'Message rejected by Infobip' } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'ib_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: 'failed',
        messageType: 'sms',
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: null,
        error: err.message,
      };
    }
  }

  /**
   * Simulated mode for when no API key/base URL is configured. Used for
   * development/testing — matches adapters/payments/stripe.ts's pattern.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const txId = 'ib-' + randomUUID().replace(/-/g, '').slice(0, 8) + '-' + randomUUID().replace(/-/g, '').slice(0, 4);
    const cost = this.config.messageCost || 0.008;

    const responsePayload: InfobipSendResponse = {
      bulkId: 'sim-' + randomUUID().replace(/-/g, '').slice(0, 12),
      messages: [
        {
          to: recipient,
          status: {
            groupId: 1,
            groupName: 'PENDING',
            id: 7,
            name: 'PENDING_ENROUTE',
            description: 'Message sent to next network node.',
          },
          messageId: txId,
          smsCount: Math.ceil(content.length / 160),
        },
      ],
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
      response: responsePayload,
    };
  }
}
