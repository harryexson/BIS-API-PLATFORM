import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real Africa's Talking SMS provider adapter.
 *
 * Uses the Africa's Talking Messaging API (POST /version1/messaging), one
 * of the priority providers named in the master plan (Phase 16) for
 * East/West African SMS routing.
 *
 * Facts below were verified via web search against Africa's Talking's
 * public documentation on 2026-09-08 — search snippets, not a directly
 * fetched page (this environment's outbound network access is restricted;
 * see docs/IMPLEMENTATION_BASELINE.md §6 item 1). Not yet verified against
 * a live account — no credentials were available in this session. Treat
 * as "built from real, current documentation" rather than "certified
 * against a live sandbox."
 *
 * Environment variables:
 *   AFRICASTALKING_API_KEY  — sent as the `apiKey` header
 *   AFRICASTALKING_USERNAME — account username ("sandbox" for the sandbox
 *                             environment, otherwise your live username)
 *
 * Sandbox vs. live is driven by this provider's registered
 * `environment` ('test' | 'live'), the same concept already used
 * elsewhere in the registry — not a separate env var.
 */

interface AfricasTalkingRecipient {
  statusCode: number;
  number: string;
  status: string; // 'Success' on success; a human-readable failure reason otherwise
  cost?: string;
  messageId?: string;
}

interface AfricasTalkingSendResponse {
  SMSMessageData: {
    Message: string;
    Recipients: AfricasTalkingRecipient[];
  };
}

const LIVE_BASE_URL = 'https://api.africastalking.com';
const SANDBOX_BASE_URL = 'https://api.sandbox.africastalking.com';

export class AfricasTalkingProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.AFRICASTALKING_API_KEY || '';
  }

  private get username(): string {
    return this.secrets.username || process.env.AFRICASTALKING_USERNAME || '';
  }

  private get baseUrl(): string {
    return this.config.environment === 'live' ? LIVE_BASE_URL : SANDBOX_BASE_URL;
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+254700000000', content = 'Hello' } = payload;
    const startTime = Date.now();

    // No API key or username configured — fall back to simulated mode.
    // Matches the established pattern in adapters/payments/stripe.ts and
    // the (now real) infobip.ts: the platform must keep working in
    // dev/test without real credentials, and every existing test relies
    // on that.
    if (!this.apiKey || !this.username) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/version1/messaging`,
        headers: {
          apiKey: this.apiKey,
          Accept: 'application/json',
        },
        body: {
          username: this.username,
          to: recipient,
          message: content,
          ...((payload as any).from ? { from: (payload as any).from } : {}),
        },
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        throw new Error(`Africa's Talking API error: HTTP ${res.status} — ${JSON.stringify(res.body)}`);
      }

      const body = res.body as AfricasTalkingSendResponse;
      const recipientResult = body?.SMSMessageData?.Recipients?.[0];
      if (!recipientResult) {
        throw new Error("Africa's Talking response did not include a recipient result");
      }

      // Only "Success" means the SMS gateway accepted the message — every
      // other status string (InvalidPhoneNumber, InsufficientBalance,
      // UserInBlackList, etc.) is a real rejection reported by the
      // provider itself, never fabricated. A 2xx HTTP response can still
      // carry a per-recipient failure here.
      const succeeded = recipientResult.status === 'Success';

      return {
        id: recipientResult.messageId || 'at_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: succeeded ? 'success' : 'failed',
        messageType: 'sms',
        latency,
        cost: this.config.messageCost || 0.006,
        decisionReason,
        payload,
        response: body,
        ...(succeeded ? {} : { error: recipientResult.status }),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'at_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no API key/username is configured. Used for
   * development/testing — matches adapters/payments/stripe.ts's pattern.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+254700000000', content = 'Hello' } = payload;
    const txId = 'ATPid_sim_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const cost = this.config.messageCost || 0.006;

    const responsePayload: AfricasTalkingSendResponse = {
      SMSMessageData: {
        Message: 'Sent to 1/1 Total Cost: KES 0.0000 (simulated)',
        Recipients: [
          {
            statusCode: 101,
            number: recipient,
            status: 'Success',
            cost: 'KES 0.0000',
            messageId: txId,
          },
        ],
      },
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
