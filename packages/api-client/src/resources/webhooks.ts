import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpClient } from '../http';
import { ApiError } from '../errors';
import { RequestOptions, WebhookEndpointCreate, WebhookEndpointCreated, WebhookEndpointSummary, WebhookEvent } from '../types';

/**
 * Registration + verification for outbound platform webhooks — your own
 * callback URL that receives a signed TransactionEvent as your
 * payments/messages/other events happen.
 *
 * register()/list()/delete() call the real, wired-up gateway routes
 * (services/api-gateway/src/app.ts's `/v1/api/gateway/webhooks*`,
 * dispatching through packages/events/src/webhook-delivery.ts). Every
 * delivery is signed: an `X-Webhook-Signature: sha256=<hex>` header,
 * computed as HMAC-SHA256(secret, JSON body) — verify()/constructEvent()
 * below check exactly that construction against the secret register()
 * returns (shown once, at creation).
 *
 * This is intentionally provider-agnostic — it does NOT implement inbound
 * provider webhook verification (Stripe/Flutterwave/etc.), which lives
 * server-side in packages/workers/src/jobs/{payment,provider}Webhook.ts.
 */
export class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  /** POST /v1/api/gateway/webhooks — returns the signing secret once. */
  async register(input: WebhookEndpointCreate, opts?: Omit<RequestOptions, 'idempotencyKey'>): Promise<WebhookEndpointCreated> {
    return this.http.request<WebhookEndpointCreated>('POST', '/v1/api/gateway/webhooks', {
      body: input,
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }

  /** GET /v1/api/gateway/webhooks — never includes the secret. */
  async list(opts?: Omit<RequestOptions, 'idempotencyKey'>): Promise<WebhookEndpointSummary[]> {
    const res = await this.http.request<{ endpoints: WebhookEndpointSummary[]; count: number }>(
      'GET',
      '/v1/api/gateway/webhooks',
      { correlationId: opts?.correlationId, signal: opts?.signal },
    );
    return res.endpoints;
  }

  /** DELETE /v1/api/gateway/webhooks/:id */
  async delete(id: string, opts?: Omit<RequestOptions, 'idempotencyKey'>): Promise<void> {
    await this.http.request<void>('DELETE', `/v1/api/gateway/webhooks/${encodeURIComponent(id)}`, {
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }

  verify(rawBody: string, signature: string, secret: string): boolean {
    const expected = this.computeSignature(rawBody, secret);
    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  constructEvent(rawBody: string, signature: string, secret: string): WebhookEvent {
    if (!this.verify(rawBody, signature, secret)) {
      throw new ApiError({ error: 'Webhook signature verification failed' }, 401);
    }
    try {
      return JSON.parse(rawBody) as WebhookEvent;
    } catch {
      throw new ApiError({ error: 'Webhook payload is not valid JSON' }, 400);
    }
  }

  private computeSignature(rawBody: string, secret: string): string {
    return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  }
}
