import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real Vibes SMS provider adapter — LOWER CONFIDENCE than the other real
 * adapters in this file tree (infobip.ts, africastalking.ts, sinch.ts).
 * Read this whole comment before trusting or extending it.
 *
 * Vibes' MessageAPI (HTTP interface) is XML, not JSON, unlike every other
 * provider in this platform. Facts below were gathered via web search on
 * 2026-09-09 against Vibes' public documentation (developer-aggregation.vibes.com)
 * — this environment cannot directly fetch pages (see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1), and search snippets for
 * Vibes were noticeably thinner than for Infobip/Africa's Talking/Sinch:
 *
 * CONFIRMED (directly evidenced by search results):
 *   - Base URL: https://messageapi.vibesapps.com (US/Canada SMS)
 *   - Auth: HTTP Basic, username = account email, password = account
 *     password — `Authorization: Basic base64(email:password)`
 *   - Content-Type: text/xml required on every request
 *   - Request root element `mtMessage` with a `submitterMessageId`
 *     attribute; child elements `destination`, `source`, `text`,
 *     optional `receiptOption` with a `callbackUrl`
 *   - A successful response returns a generated message ID
 *
 * NOT CONFIRMED — reconstructed from a documented URL *pattern*
 * ("all POST methods follow /MessageApi/<method>/<id>") plus a sibling
 * GET path that reads from an `mt/messages` resource
 * (`/MessageApi/mt/messages/{messageid}/parts`), not from an observed
 * example request/response for the actual submit call:
 *   - The exact submit path (`/MessageApi/mt/messages` below is inferred,
 *     not observed)
 *   - The `destination`/`source` element's `type` attribute and its valid
 *     values — omitted below rather than guessed, since a wrong value
 *     risks a real rejection more than an absent one
 *   - The exact response XML schema/tag names for the returned message ID
 *     — parsed defensively below (first plausible id-like attribute or
 *     element found), not against a confirmed schema
 *   - The error response format
 *
 * Do not treat this adapter as production-ready without verifying it
 * against a live Vibes sandbox account or the actual documentation pages
 * — do not remove this comment until that's done.
 *
 * Environment variables:
 *   VIBES_USERNAME — account email used for HTTP Basic auth
 *   VIBES_PASSWORD — account password used for HTTP Basic auth
 */

const VIBES_BASE_URL = 'https://messageapi.vibesapps.com';
// Inferred path — see "NOT CONFIRMED" above.
const VIBES_SUBMIT_PATH = '/MessageApi/mt/messages';

export class VibesProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get username(): string {
    return this.secrets.username || process.env.VIBES_USERNAME || '';
  }

  private get password(): string {
    return this.secrets.password || process.env.VIBES_PASSWORD || '';
  }

  private buildRequestXml(submitterMessageId: string, recipient: string, from: string, content: string): string {
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<mtMessage submitterMessageId="${escape(submitterMessageId)}">` +
      `<destination address="${escape(recipient)}"/>` +
      `<source address="${escape(from)}"/>` +
      `<text>${escape(content)}</text>` +
      `</mtMessage>`
    );
  }

  /**
   * Best-effort extraction of a provider-assigned message id from an XML
   * response whose exact schema isn't confirmed (see class comment).
   * Looks for a messageId/message_id/id attribute or element; returns
   * null rather than fabricating one if nothing plausible is found.
   */
  private extractMessageId(xml: string): string | null {
    const attrMatch = xml.match(/messageId\s*=\s*"([^"]+)"/i) || xml.match(/message_id\s*=\s*"([^"]+)"/i);
    if (attrMatch) return attrMatch[1];
    const elMatch = xml.match(/<messageId>([^<]+)<\/messageId>/i) || xml.match(/<message_id>([^<]+)<\/message_id>/i);
    if (elMatch) return elMatch[1];
    return null;
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const startTime = Date.now();

    // No credentials configured — fall back to simulated mode. Matches the
    // established pattern in adapters/payments/stripe.ts and the other
    // real adapters in this directory.
    if (!this.username || !this.password) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    const submitterMessageId = randomUUID();
    const from = (payload as any).from || this.config.name;

    try {
      const basicAuth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const requestXml = this.buildRequestXml(submitterMessageId, recipient, from, content);

      const res = await this.http_request({
        method: 'POST',
        url: `${VIBES_BASE_URL}${VIBES_SUBMIT_PATH}`,
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'text/xml',
        },
        body: requestXml,
      });

      const latency = Date.now() - startTime;
      const responseText = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);

      if (res.status >= 400) {
        throw new Error(`Vibes API error: HTTP ${res.status} — ${responseText.slice(0, 500)}`);
      }

      const messageId = this.extractMessageId(responseText);
      if (!messageId) {
        // Never fabricate a message id — an unparseable response is a
        // failure to report, not a success to invent.
        throw new Error('Vibes response did not include a recognizable message id');
      }

      return {
        id: messageId,
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: 'success',
        messageType: 'sms',
        latency,
        cost: this.config.messageCost || 0.007,
        decisionReason,
        payload,
        response: { raw: responseText, submitterMessageId },
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'vibes_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no credentials are configured. Used for
   * development/testing — matches adapters/payments/stripe.ts's pattern.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const txId = 'vibes-sim-' + randomUUID().replace(/-/g, '').slice(0, 16);
    const cost = this.config.messageCost || 0.007;

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
      response: {
        raw: `<mtMessageResponse messageId="${txId}"><status>ACCEPTED (simulated)</status><to>${recipient}</to></mtMessageResponse>`,
      },
    };
  }
}
