import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors';
import { WebhookEvent } from '../types';

/**
 * Helper utilities for verifying outbound platform webhooks delivered to
 * your configured endpoint.
 *
 * IMPORTANT — current server state: packages/events/src/webhook-delivery.ts
 * (the platform's outbound delivery implementation) does not sign its
 * requests today. It POSTs the raw event body with `X-Webhook-Id` /
 * `X-Webhook-Attempt` headers only — there is no `X-Signature` header to
 * verify. verify()/constructEvent() are kept here ready for when outbound
 * signing is added (this is a real, currently-unaddressed gap — see the
 * production-readiness report), but calling them against a real delivery
 * today will only ever see `signature` values you construct yourself, not
 * anything the platform sent.
 *
 * This is intentionally provider-agnostic — it does NOT implement inbound
 * provider webhook verification (Stripe/Flutterwave/etc.), which lives
 * server-side in packages/workers/src/jobs/{payment,provider}Webhook.ts.
 */
export class WebhooksResource {
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
