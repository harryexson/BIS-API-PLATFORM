import { createHmac, timingSafeEqual } from 'crypto';
import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';

function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createPaymentWebhookProcessor(deps: JobDeps): JobProcessor {
  return async (job, ctx: WorkerContext) => {
    const { appId, providerId, rawBody, signature, id } = job.payload;

    if (!appId || !providerId) {
      throw new Error('payment_webhook requires appId and providerId');
    }

    const eventId = id || job.payload.eventId;
    if (eventId && ctx?.store) {
      const seen = await ctx.store.setNx(
        deps.keys.idempotency(`webhook:${eventId}`),
        '1',
        deps.config.idempotencyTtlMs,
      );
      if (!seen) {
        throw new Error('Replay detected: payment webhook already processed');
      }
    }

    const secret = process.env.WEBHOOK_HMAC_SECRET;
    if (secret) {
      if (!signature || !rawBody) {
        throw new Error('payment_webhook signature required');
      }
      if (!verifySignature(secret, rawBody, signature)) {
        throw new Error('payment_webhook signature verification failed');
      }
    } else {
      console.warn(
        '[payment_webhook] WEBHOOK_HMAC_SECRET not configured; processing UNVERIFIED webhook (insecure)',
      );
    }

    const clean = { ...job.payload };
    delete (clean as any).rawBody;
    delete (clean as any).signature;

    try {
      await eventRepository.create({
        appId,
        category: 'payment_webhook',
        providerId,
        status: 'success',
        decisionReason: 'payment_webhook_received',
        payload: clean,
        response: clean.data ?? null,
      });
    } catch (err) {
      console.error('[payment_webhook] Neon write failed', err);
    }

    deps.eventBus.emit({
      id: id || `wh_${Date.now()}`,
      timestamp: new Date().toISOString(),
      appId,
      category: 'payment',
      providerId,
      status: 'success',
      latency: 0,
      cost: 0,
      decisionReason: 'payment_webhook_received',
      payload: clean,
      response: clean.data ?? null,
    });
  };
}
