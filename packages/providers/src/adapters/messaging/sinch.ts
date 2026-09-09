import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, MessageRequest } from '@company/schemas';

/**
 * Real Sinch SMS provider adapter.
 *
 * Uses the Sinch SMS API's Batches endpoint
 * (POST /xms/v1/{SERVICE_PLAN_ID}/batches). Net-new provider — no adapter,
 * registry entry, or env vars existed before this was added.
 *
 * Facts below were verified via web search against Sinch's public
 * documentation on 2026-09-09 — search snippets, not a directly fetched
 * page (this environment's outbound network access is restricted; see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1). Not yet verified against a
 * live Sinch account — no credentials were available in this session.
 * Treat as "built from real, current documentation" rather than
 * "certified against a live sandbox."
 *
 * Environment variables:
 *   SINCH_API_TOKEN      — sent as `Authorization: Bearer <token>`
 *   SINCH_SERVICE_PLAN_ID — Sinch service plan id (part of the URL path)
 *   SINCH_REGION          — 'us' (default) or 'eu' — Sinch serves SMS from
 *                           regional endpoints, not a single global one
 */

interface SinchBatchResponse {
  id: string;
  to: string[];
  from: string;
  body?: string;
  canceled: boolean;
  created_at: string;
  modified_at: string;
}

interface SinchErrorResponse {
  code?: string;
  text?: string;
}

export class SinchProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiToken(): string {
    return this.secrets.api_key || process.env.SINCH_API_TOKEN || '';
  }

  private get servicePlanId(): string {
    return this.secrets.service_plan_id || process.env.SINCH_SERVICE_PLAN_ID || '';
  }

  private get region(): string {
    return process.env.SINCH_REGION || 'us';
  }

  async processRequest(appId: string, payload: MessageRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const startTime = Date.now();

    // No token or service plan id configured — fall back to simulated mode.
    // Matches the established pattern in adapters/payments/stripe.ts and
    // the real infobip.ts/africastalking.ts adapters.
    if (!this.apiToken || !this.servicePlanId) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `https://${this.region}.sms.api.sinch.com/xms/v1/${this.servicePlanId}/batches`,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: {
          from: (payload as any).from || this.config.name,
          to: [recipient],
          body: content,
        },
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        const errBody = res.body as SinchErrorResponse;
        throw new Error(errBody?.text || `Sinch API error: HTTP ${res.status}`);
      }

      const body = res.body as SinchBatchResponse;
      if (!body?.id) {
        throw new Error('Sinch response did not include a batch id');
      }

      // A successful batch response only confirms Sinch *accepted* the
      // batch (canceled: false) — it is not a delivery confirmation.
      // Sinch's per-recipient delivery status arrives later via a
      // delivery report webhook, never fabricated here.
      return {
        id: body.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'messaging',
        providerId: this.config.id,
        status: body.canceled ? 'failed' : 'success',
        messageType: 'sms',
        latency,
        cost: this.config.messageCost || 0.007,
        decisionReason,
        payload,
        response: body,
        ...(body.canceled ? { error: 'Batch was canceled by Sinch' } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'sinch_err_' + randomUUID().replace(/-/g, '').slice(0, 16),
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
   * Simulated mode for when no API token/service plan id is configured.
   * Used for development/testing — matches adapters/payments/stripe.ts's
   * pattern.
   */
  private async simulatedProcess(
    appId: string,
    payload: MessageRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { recipient = '+15005550006', content = 'Hello' } = payload;
    const txId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    const cost = this.config.messageCost || 0.007;
    const now = new Date().toISOString();

    const responsePayload: SinchBatchResponse = {
      id: 'sim-' + txId,
      to: [recipient],
      from: (payload as any).from || this.config.name,
      body: content,
      canceled: false,
      created_at: now,
      modified_at: now,
    };

    return {
      id: 'sim-' + txId,
      timestamp: now,
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
