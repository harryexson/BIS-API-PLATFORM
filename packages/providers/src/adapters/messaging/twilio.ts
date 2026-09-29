import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real Twilio SMS/WhatsApp provider adapter.
 *
 * Uses Twilio's Programmable Messaging API (`POST
 * /2010-04-01/Accounts/{AccountSid}/Messages.json`) — the single most
 * standard SMS/WhatsApp API in the industry, and a real gap this package
 * had until now despite integrating many smaller/regional messaging
 * providers. Facts below (endpoint, auth, request/response shape, status
 * values, error envelope) were verified via web search against Twilio's
 * public API documentation on 2026-09-29 (this environment's outbound
 * network access to twilio.com is restricted — see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint on
 * other adapters), not a live account. Treat as "built from real,
 * current documentation" rather than "certified against a live
 * sandbox."
 *
 * Auth is HTTP Basic with `AccountSid:AuthToken` — unlike most adapters
 * here, the account identifier itself (not just a secret key) is part of
 * both the credential and the request URL path.
 *
 * The request body is `application/x-www-form-urlencoded` (`To`, `From`,
 * `Body`) — the same non-JSON convention Stripe/NMI use here, via
 * `BaseProvider.toFormBody()`. `From` must be a real Twilio-owned phone
 * number or Messaging Service SID configured on the account — this
 * platform's `MessageRequest` has no first-class slot for it, read from
 * `TWILIO_FROM_NUMBER`/`this.secrets.from_number` (an env var/admin
 * secret, not per-message data, since it's an account-level sending
 * identity, not something a caller would plausibly override per
 * message). Without an account SID, auth token, or a from-number, this
 * adapter falls back to simulated processing — never a real call with no
 * real sender identity to send from.
 *
 * WhatsApp uses this exact same endpoint with `whatsapp:` prefixed onto
 * both `To` and `From` — this adapter does that automatically when
 * `payload.metadata.channel === 'whatsapp'`.
 *
 * Twilio responds synchronously with the message's *initial* status
 * (typically `queued`/`accepted`/`sending`/`sent`) — real delivery
 * confirmation (`delivered`/`undelivered`/`read`) only arrives later via
 * a status-callback webhook this platform doesn't consume yet. Consistent
 * with `infobip.ts`'s identical convention here, any synchronous status
 * other than `failed`/`undelivered` (a message Twilio has already
 * rejected outright) is reported as this platform's messaging `'success'`
 * — "accepted for processing," not "confirmed on the handset."
 * `error_code`/`error_message` (present only on `failed`/`undelivered`)
 * surface as the error.
 *
 * Native inbound-webhook signature verification is deliberately not
 * implemented here (falls back to the platform's generic HMAC check) —
 * Twilio's real `X-Twilio-Signature` scheme needs the exact full public
 * URL Twilio called (not just the raw body) concatenated with every POST
 * parameter sorted alphabetically, then HMAC-SHA1'd. Twilio's own
 * documentation explicitly warns that subtle parsing/host mismatches
 * (e.g. behind a proxy) silently break this and recommends using their
 * SDK rather than a manual implementation — the same "real complexity,
 * can't verify canonicalization without a live account" reasoning
 * adyen.ts and pawapay.ts already document for their own declined
 * webhook schemes.
 *
 * Environment variables:
 *   TWILIO_ACCOUNT_SID — starts with AC...
 *   TWILIO_AUTH_TOKEN  — the account's primary auth token
 *   TWILIO_FROM_NUMBER — a Twilio phone number (E.164) or Messaging
 *     Service SID this account owns, used as the `From` value
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

  public isConfigured(): boolean {
    return Boolean(this.accountSid && this.authToken && this.fromNumber);
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const isWhatsApp = (payload as any).metadata?.channel === 'whatsapp';
    const startTime = Date.now();

    if (!this.isConfigured()) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const basicAuth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
      const body = this.toFormBody({
        To: isWhatsApp ? `whatsapp:${recipient}` : recipient,
        From: isWhatsApp ? `whatsapp:${this.fromNumber}` : this.fromNumber,
        Body: content,
      });

      const res = await this.http_request({
        method: 'POST',
        url: `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const err = res.body;
        throw new Error(err?.message || `Twilio API error: HTTP ${res.status}`);
      }

      const message = res.body;
      if (!message?.sid) {
        throw new Error('Twilio response did not include a message sid');
      }

      // failed/undelivered: Twilio has already definitively rejected the
      // message. Every other synchronous status (queued/accepted/sending/
      // sent/delivered) means "accepted for processing" — real delivery
      // confirmation is async, via a status-callback webhook this
      // platform doesn't consume, matching infobip.ts's identical rule.
      const rejected = ['failed', 'undelivered'].includes(message.status);

      return {
        id: message.sid,
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: rejected ? 'failed' : 'success',
        messageType: isWhatsApp ? 'whatsapp' : 'sms',
        latency,
        cost: this.config.messageCost || 0.0079,
        decisionReason,
        payload,
        response: message,
        ...(rejected ? { error: message.error_message || `Twilio message status: ${message.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'twilio_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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

  /**
   * Simulated mode for when no account SID/auth token/from-number is
   * configured. Used for development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const isWhatsApp = (payload as any).metadata?.channel === 'whatsapp';
    const sid = 'SM' + randomUUID().replace(/-/g, '').slice(0, 32);
    const cost = this.config.messageCost || 0.0079;

    const responsePayload = {
      sid,
      status: 'queued',
      to: isWhatsApp ? `whatsapp:${recipient}` : recipient,
      from: isWhatsApp ? 'whatsapp:+15005550006' : '+15005550006',
      body: content,
      error_code: null,
    };

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
      response: responsePayload,
    };
  }
}
