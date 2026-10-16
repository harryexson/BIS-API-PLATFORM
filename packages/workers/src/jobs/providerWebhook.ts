import { createHmac, timingSafeEqual } from 'crypto';
import { Job, JobProcessor } from '../types';
import { JobDeps } from './deps';
import { webhookEventRepository } from '@company/database';
import { runDurableWebhookConsumer, type WebhookEventStore } from '../webhookEvents';

function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // P1-5 FIX: Use hex encoding for both buffers to match the gateway's comparison.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createProviderWebhookProcessor(deps: JobDeps): JobProcessor {
  return async (job) => {
    const { providerId, rawBody, signature, id } = job.payload;

    if (!providerId) {
      throw new Error('provider_webhook requires providerId');
    }

    // Phase 4: durable identity is (providerId, provider event id).
    const eventId = id || job.payload.eventId;
    if (!eventId) {
      throw new Error('provider_webhook requires an event id (durable webhook identity)');
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
      // P0: FAIL CLOSED — reject webhooks when HMAC secret is not configured.
      console.error(
        '[provider_webhook] REJECTING webhook — WEBHOOK_HMAC_SECRET not configured. Cannot verify authenticity.',
      );
      throw new Error('provider_webhook rejected: WEBHOOK_HMAC_SECRET not configured — cannot verify webhook authenticity');
    }

    // B5 FIX: replaces the Redis/memory `setNx` replay marker that was set
    // BEFORE processing and never cleared (see paymentWebhook.ts). This mattered
    // even more here: the provider lock below is shared with provider_health,
    // so a webhook arriving mid-health-check threw "Unable to acquire
    // distributed lock" AFTER the marker was set and was then lost forever
    // as a false "Replay detected". Now that failure is recorded durably as
    // `failed` and the retry re-claims it cleanly.
    const store = deps.webhookEvents ?? webhookEventRepository;
    await runDurableWebhookConsumer(
      store,
      'provider_webhook',
      {
        webhookEventId: job.payload.webhookEventId,
        providerId,
        providerEventId: String(eventId),
        fallbackRow: () => {
          let body: unknown = {};
          try {
            body = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            body = {};
          }
          return {
            appId: null,
            tenantId: null,
            eventType: job.payload.status ?? null,
            payload: body,
            rawBody: rawBody ?? '',
            signature: signature ?? null,
          };
        },
      },
      (event) => processProviderWebhook(job, deps, store, event.id),
      { leaseMs: deps.config.webhookConsumerLeaseMs },
    );
  };
}

async function processProviderWebhook(job: Job, deps: JobDeps, store: WebhookEventStore, webhookEventId: string): Promise<void> {
  const { providerId, status, id } = job.payload;

  const owner = `webhook_${providerId}_${Math.random().toString(36).slice(2, 8)}`;
  const ttl = deps.config.retry.maxDelayMs;

  // B15: a webhook's status update must not be skipped, so this uses
  // withLock — which now waits (bounded backoff) for a concurrent health
  // check to release the lock instead of throwing at once, and only throws
  // LockNotAcquiredError (→ normal job retry) if it is still held after that.
  await deps.lock.withLock(`provider:${providerId}`, owner, ttl, async () => {
    if (status) {
      deps.registry.updateManagement(providerId, { status });
    }
  });

  const clean = { ...job.payload };
  delete (clean as any).rawBody;
  delete (clean as any).signature;

  // At most once per durable webhook event (see paymentWebhook.ts), so a
  // retry after a later failure does not record this webhook twice.
  try {
    await store.persistEffectsOnce({
      idempotencyKey: `webhook:${webhookEventId}:provider_webhook`,
      event: {
        appId: 'system',
        category: 'provider_webhook',
        providerId,
        status: 'success',
        decisionReason: status ? `provider_webhook_status:${status}` : 'provider_webhook_received',
        payload: clean,
      },
    });
  } catch (err) {
    // P0: Fail the job on DB error so it can be retried — previously this
    // was silently swallowed and the job was marked complete.
    console.error('[provider_webhook] Neon write failed — failing job for retry', err);
    throw new Error('provider_webhook: database write failed — retrying');
  }

  await deps.eventBus.emit({
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
}
