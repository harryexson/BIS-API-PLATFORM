import { createHmac, timingSafeEqual } from 'crypto';
import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';

function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // P1-5 FIX: Use hex encoding for both buffers to match the gateway's comparison.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createProviderWebhookProcessor(deps: JobDeps): JobProcessor {
  return async (job, ctx: WorkerContext) => {
    const { providerId, rawBody, signature, status, id } = job.payload;

    if (!providerId) {
      throw new Error('provider_webhook requires providerId');
    }

    const eventId = id || job.payload.eventId;
    if (eventId && ctx?.store) {
      const seen = await ctx.store.setNx(
        deps.keys.idempotency(`webhook:${eventId}`),
        '1',
        deps.config.idempotencyTtlMs,
      );
      if (!seen) {
        throw new Error('Replay detected: provider webhook already processed');
      }
    }

    const secret = process.env.WEBHOOK_HMAC_SECRET;
    if (secret) {
      if (!signature || !rawBody) {
        throw new Error('provider_webhook signature required');
      }
      if (!verifySignature(secret, rawBody, signature)) {
        throw new Error('provider_webhook signature verification failed');
      }
    } else {
      console.warn(
        '[provider_webhook] WEBHOOK_HMAC_SECRET not configured; processing UNVERIFIED webhook (insecure)',
      );
    }

    const owner = `webhook_${providerId}_${Math.random().toString(36).slice(2, 8)}`;
    const ttl = deps.config.retry.maxDelayMs;

    await deps.lock.withLock(`provider:${providerId}`, owner, ttl, async () => {
      if (status) {
        deps.registry.updateManagement(providerId, { status });
      }
    });

    const clean = { ...job.payload };
    delete (clean as any).rawBody;
    delete (clean as any).signature;

    try {
      await eventRepository.create({
        appId: 'system',
        category: 'provider_webhook',
        providerId,
        status: 'success',
        decisionReason: status ? `provider_webhook_status:${status}` : 'provider_webhook_received',
        payload: clean,
      });
    } catch (err) {
      // P0: Fail the job on DB error so it can be retried — previously this
      // was silently swallowed and the job was marked complete.
      console.error('[provider_webhook] Neon write failed — failing job for retry', err);
      throw new Error('provider_webhook: database write failed — retrying');
    }

    deps.eventBus.emit({
      id: id || `wh_${Date.now()}`,
      timestamp: new Date().toISOString(),
      appId: 'system',
      category: 'other',
      providerId,
      status: 'success',
      latency: 0,
      cost: 0,
      decisionReason: 'provider_webhook_processed',
      payload: clean,
      response: null,
    });
  };
}
