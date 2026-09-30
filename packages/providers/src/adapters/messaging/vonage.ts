import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real Vonage (formerly Nexmo) SMS provider adapter.
 *
 * Uses Vonage's classic SMS API (`POST https://rest.nexmo.com/sms/json`) —
 * still the current, documented way to send a one-off SMS, rather than the
 * newer Messages API (which targets multi-channel — SMS/WhatsApp/Viber/
 * Messenger — apps with JWT/application-id auth, more setup than this
 * platform's merchant-initiated single-channel sends need). Facts below
 * (endpoint, auth, request/response shape, status codes) were verified via
 * web search against Vonage's public API documentation on 2026-09-29 (this
 * environment's outbound network access to nexmo.com/vonage.com is
 * restricted — see docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same
 * constraint on other adapters), not a live account. Treat as "built from
 * real, current documentation" rather than "certified against a live
 * sandbox."
 *
 * Auth is `api_key`/`api_secret` — Vonage's docs show these either as HTTP
 * Basic Auth or as plain fields in the request body; this adapter uses the
 * body-field form (consistent with this platform's other form-encoded
 * adapters — Stripe/NMI/Twilio — via `BaseProvider.toFormBody()`, and
 * avoids a second, redundant Basic-Auth header for the same credential).
 *
 * `from` is account-level config (`this.secrets.from_number`/
 * `VONAGE_FROM_NUMBER`), not per-message data — a Vonage-registered sender
 * ID or long virtual number, the same convention `twilio.ts` uses for its
 * own `From`. Without an API key, API secret, or a from-identity, this
 * adapter falls back to simulated processing — never a real call with no
 * real sender identity to send from.
 *
 * The SMS API's response is synchronous and definitive per-message:
 * `{ "messages": [{ "status": "0" | ..., "message-id": ..., ... }] }`.
 * Unlike Twilio/Infobip's "accepted for processing, confirm later via
 * webhook" convention, a non-`"0"` status here is a real, immediate
 * rejection of the submit attempt itself (throttled, invalid params, bad
 * credentials, internal error) — never an ambiguous pending state — so
 * every non-`"0"` status maps to this platform's `'failed'`, not
 * `'unknown'`.
 *
 * Native inbound-webhook signature verification is deliberately not
 * implemented here (falls back to the platform's generic HMAC check).
 * Vonage's classic SMS API only signs delivery-receipt/inbound webhooks at
 * all when the account has "Signed Webhooks" explicitly turned on in the
 * dashboard (off by default), and even then the scheme is a `sig` query
 * parameter computed over the full parameter set with an account-chosen
 * hash algorithm (MD5/SHA-1/SHA-256) selected in that same dashboard
 * setting — a per-account configuration this adapter has no way to know
 * or verify without a live account, the same "real complexity, can't
 * verify canonicalization without a live account" reasoning `twilio.ts`
 * and `adyen.ts` already document for their own declined webhook schemes.
 *
 * Environment variables:
 *   VONAGE_API_KEY     — the account's API key
 *   VONAGE_API_SECRET  — the account's API secret
 *   VONAGE_FROM_NUMBER — a Vonage-registered sender ID or virtual number,
 *     used as the `from` value
 */
export class VonageProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.VONAGE_API_KEY || '';
  }

  private get apiSecret(): string {
    return this.secrets.api_secret || process.env.VONAGE_API_SECRET || '';
  }

  private get fromNumber(): string {
    return this.secrets.from_number || process.env.VONAGE_FROM_NUMBER || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiSecret && this.fromNumber);
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const startTime = Date.now();

    if (!this.isConfigured()) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const body = this.toFormBody({
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        to: recipient,
        from: this.fromNumber,
        text: content,
      });

      const res = await this.http_request({
        method: 'POST',
        url: 'https://rest.nexmo.com/sms/json',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        throw new Error(`Vonage API error: HTTP ${res.status}`);
      }

      const message = res.body?.messages?.[0];
      if (!message?.['message-id']) {
        throw new Error('Vonage response did not include a message-id');
      }

      // status "0" is Vonage's only success code — every other value is a
      // real, immediate, synchronous rejection of this submit attempt
      // (see class comment), not an ambiguous pending state.
      const accepted = message.status === '0';

      return {
        id: message['message-id'],
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: accepted ? 'success' : 'failed',
        messageType: 'sms',
        latency,
        cost: this.config.messageCost || 0.0067,
        decisionReason,
        payload,
        response: message,
        ...(accepted ? {} : { error: message['error-text'] || `Vonage status code: ${message.status}` }),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'vonage_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no API key/secret/from-number is configured.
   * Used for development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const messageId = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    const cost = this.config.messageCost || 0.0067;

    const responsePayload = {
      'message-count': '1',
      messages: [
        {
          to: recipient,
          'message-id': messageId,
          status: '0',
          'remaining-balance': '10.00000000',
          'message-price': String(cost),
          network: 'sim',
        },
      ],
    };

    return {
      id: messageId,
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
