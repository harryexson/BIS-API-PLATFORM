import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors';
import { WebhookEvent } from '../types';

// Helper utilities for verifying OUTBOUND platform webhooks delivered to your
// configured endpoint. The platform signs the raw request body with HMAC-SHA256
// using your webhook signing secret and sends it in the `X-Signature` header
// (optionally prefixed with `sha256=`).
//
// This is intentionally provider-agnostic — it does NOT implement inbound
// provider webhook verification (Stripe/Flutterwave/etc.), which lives in the
// platform's webhook service.
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
      throw new ApiError(401, {
        code: 'authentication_failed',
        message: 'Webhook signature verification failed'
      });
    }
    try {
      return JSON.parse(rawBody) as WebhookEvent;
    } catch {
      throw new ApiError(400, {
        code: 'invalid_request',
        message: 'Webhook payload is not valid JSON'
      });
    }
  }

  private computeSignature(rawBody: string, secret: string): string {
    return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  }
}
