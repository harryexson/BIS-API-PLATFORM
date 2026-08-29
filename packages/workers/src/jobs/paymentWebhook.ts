import { createHmac, timingSafeEqual } from 'crypto';
import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository, outboxEventRepository, transactionRepository, runInTransaction } from '@company/database';
import { ProviderWebhookEvent } from '@company/schemas';

function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // P1-5 FIX: Use hex encoding for both buffers to match the gateway's comparison.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createPaymentWebhookProcessor(deps: JobDeps): JobProcessor {
  return async (job, ctx: WorkerContext) => {
    const payload = job.payload as Partial<ProviderWebhookEvent>;
    const { provider, rawBody, signature, providerEventId } = payload;
    const appId = payload.applicationId || 'webhook';

    if (!provider) {
      throw new Error('payment_webhook requires provider');
    }

    // P0: Idempotency check using provider event ID
    const eventId = providerEventId || job.payload.id;
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

    // Build clean event record (strip raw webhook data)
    const clean = { ...job.payload };
    delete (clean as any).rawBody;
    delete (clean as any).signature;

    // P0 FIX: Normalize webhook type → eventType.
    // Stripe webhooks use `type` (e.g., "charge.succeeded") but the
    // ProviderWebhookEvent schema defines `eventType`. The receipt pipeline
    // consumes `eventType`, so we must propagate it correctly.
    if (clean.type && !clean.eventType) {
      clean.eventType = clean.type;
    }

    // P0: Write event + outbox atomically in a transaction.
    // This closes the gap between "event persisted" and "event emitted".
    try {
      await runInTransaction(async (tx) => {
        // Write event record
        await eventRepository.create({
          appId,
          category: 'payment_webhook',
          providerId: provider,
          status: payload.status || 'success',
          decisionReason: 'payment_webhook_received',
          payload: clean,
          response: clean.data ?? null,
        });

        // Write outbox event (atomic with event write)
        await outboxEventRepository.create({
          appId,
          eventType: 'payment_webhook_received',
          payload: {
            id: eventId || `wh_${Date.now()}`,
            timestamp: payload.timestamp || new Date().toISOString(),
            appId,
            category: 'payment',
            providerId: provider,
            status: payload.status || 'success',
            decisionReason: 'payment_webhook_received',
            payload: clean,
            response: clean.data ?? null,
          },
        });
      });
    } catch (err) {
      console.error('[payment_webhook] Neon write failed — failing job for retry', err);
      throw new Error('payment_webhook: database write failed — retrying');
    }

    // P0: Update transaction state based on webhook event type
    const providerTxId = clean.data?.object?.id || providerEventId;
    if (providerTxId) {
      try {
        const tx = await transactionRepository.findByProviderTransactionId(String(providerTxId));
        if (tx) {
          const newStatus =
            clean.eventType === 'charge.succeeded' ? 'success'
            : clean.eventType === 'charge.failed' ? 'failed'
            : clean.eventType === 'charge.refunded' ? 'refunded'
            : clean.eventType === 'charge.pending' ? 'pending'
            : tx.status;
          if (newStatus !== tx.status) {
            await transactionRepository.updateStatus(tx.id, newStatus);
          }
        }
      } catch (err) {
        console.error('[payment_webhook] Transaction state update failed', err);
        // Don't throw — the event was already persisted, this is best-effort
      }
    }

    // Emit normalized event to EventBus for downstream pipeline (receipt, outbox, etc.)
    deps.eventBus.emit({
      id: eventId || `wh_${Date.now()}`,
      timestamp: payload.timestamp || new Date().toISOString(),
      appId,
      category: 'payment',
      providerId: provider,
      status: payload.status || 'success',
      latency: 0,
      cost: 0,
      decisionReason: 'payment_webhook_received',
      payload: clean,
      response: clean.data ?? null,
    });
  };
}
