import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

const API_VERSION = 'v21.0';

/**
 * Real WhatsApp Business Platform (Meta Cloud API) provider adapter.
 *
 * Uses Meta's own Cloud API directly (`POST
 * /{API_VERSION}/{phone_number_id}/messages` on `graph.facebook.com`) —
 * distinct from twilio.ts, which reaches WhatsApp *through* Twilio as a
 * reseller. This is the direct Meta integration, with its own
 * credentials (a phone number id, not a phone number itself) and its
 * own template-message rules. Facts below (endpoint, auth, request/
 * response shape, webhook signature scheme) were verified via web
 * search against Meta's public developer documentation on 2026-09-29
 * (this environment's outbound network access to facebook.com/
 * developers.facebook.com is restricted — see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint on
 * other adapters), not a live account. Treat as "built from real,
 * current documentation" rather than "certified against a live
 * sandbox."
 *
 * Auth is a Bearer access token (Meta recommends a permanent System
 * User token for production, but any valid token works identically from
 * this adapter's point of view). The request path additionally requires
 * a `phone_number_id` — Meta's internal id for the sending WhatsApp
 * Business number, not the number itself — a credential this platform's
 * `MessageRequest` has no first-class slot for, configured via
 * `WHATSAPP_PHONE_NUMBER_ID`/`this.secrets.phone_number_id`. Without an
 * access token or a phone number id, this adapter falls back to
 * simulated processing — never a real call with no real sender identity.
 *
 * **Real, honest limitation, not silently worked around**: WhatsApp's
 * 24-hour customer-service-window rule means a free-form `type: 'text'`
 * message (what this adapter sends — this platform has no per-recipient
 * conversation-window tracking wired into this specific gateway call,
 * and no approved message-template name/params data to send instead)
 * only succeeds if the recipient messaged first within the last 24
 * hours. Outside that window, Meta's own API rejects the request with a
 * real error this adapter surfaces honestly (as `'failed'`, with Meta's
 * real error message) — it does not fabricate template support it
 * hasn't built, and does not pretend the send succeeded.
 *
 * A 2xx response only confirms Meta *accepted* the message for
 * processing (a `messages[0].id` comes back, no delivery status) — real
 * delivery/read confirmation arrives later via a status-callback webhook
 * this platform doesn't consume yet. Consistent with `infobip.ts`'s and
 * `twilio.ts`'s identical convention here, that's this platform's
 * messaging `'success'`; a non-2xx response (Meta's real Graph API error
 * envelope, `{ error: { message, type, code, error_subcode,
 * fbtrace_id } }`) is `'failed'`.
 *
 * Native inbound-webhook signature verification **is** implemented:
 * Meta's real `X-Hub-Signature-256` header is `sha256=` followed by a
 * hex HMAC-SHA256 of the raw request body, keyed by the Meta App Secret
 * (a separate credential from the access token) — a straightforward
 * local computation, unlike Twilio's/PayPal's declined schemes, which
 * need extra context (a URL, or a server round-trip) this adapter can't
 * safely reconstruct.
 *
 * Environment variables:
 *   WHATSAPP_ACCESS_TOKEN   — Bearer token (System User token recommended)
 *   WHATSAPP_PHONE_NUMBER_ID — Meta's id for the sending number
 *   WHATSAPP_APP_SECRET     — the Meta App's secret, used only by
 *     verifyProviderWebhookSignature() below
 */
export class WhatsAppProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get accessToken(): string {
    return this.secrets.access_token || process.env.WHATSAPP_ACCESS_TOKEN || '';
  }

  private get phoneNumberId(): string {
    return this.secrets.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  }

  private get appSecret(): string {
    return this.secrets.app_secret || process.env.WHATSAPP_APP_SECRET || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  /**
   * Verifies Meta's real `X-Hub-Signature-256` header — verified via
   * WebSearch, 2026-09-29: `sha256=` + hex HMAC-SHA256 of the raw body,
   * keyed by the Meta App Secret.
   */
  public async verifyProviderWebhookSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    const secret = this.appSecret;
    if (!secret) return null;

    const header = headers['x-hub-signature-256'];
    if (!header) return false;

    const prefix = 'sha256=';
    if (!header.startsWith(prefix)) return false;

    return this.verifyWebhookSignature(rawBody, header.slice(prefix.length), secret);
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const startTime = Date.now();

    if (!this.isConfigured()) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `https://graph.facebook.com/${API_VERSION}/${this.phoneNumberId}/messages`,
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: {
          messaging_product: 'whatsapp',
          to: recipient.replace(/^\+/, ''),
          type: 'text',
          text: { body: content, preview_url: false },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const err = res.body?.error;
        throw new Error(err?.message || `WhatsApp Cloud API error: HTTP ${res.status}`);
      }

      const message = res.body?.messages?.[0];
      if (!message?.id) {
        throw new Error('WhatsApp Cloud API response did not include a message id');
      }

      return {
        id: message.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: 'success',
        messageType: 'whatsapp',
        latency,
        cost: this.config.messageCost || 0.005,
        decisionReason,
        payload,
        response: res.body,
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'wa_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: 'failed',
        messageType: 'whatsapp',
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
   * Simulated mode for when no access token/phone number id is
   * configured. Used for development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+15005550006' } = payload;
    const messageId = 'wamid.sim_' + randomUUID().replace(/-/g, '').slice(0, 24);
    const cost = this.config.messageCost || 0.005;

    const responsePayload = {
      messaging_product: 'whatsapp',
      contacts: [{ input: recipient, wa_id: recipient.replace(/^\+/, '') }],
      messages: [{ id: messageId }],
    };

    return {
      id: messageId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId: this.config.id,
      status: 'success',
      messageType: 'whatsapp',
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload,
    };
  }
}
