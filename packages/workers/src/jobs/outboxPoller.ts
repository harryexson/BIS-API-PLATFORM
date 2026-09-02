import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { outboxEventRepository } from '@company/database';

/**
 * P0: Outbox poller worker.
 *
 * Picks up pending outbox events and emits them to EventBus.
 * This closes the durability gap between "event written to DB" and "event emitted to bus".
 * If the poller crashes between claiming and completing, the event is retried on next poll.
 *
 * Also rescues stuck outbox events that were claimed but never completed.
 */
export function createOutboxPollerProcessor(deps: JobDeps): JobProcessor {
  return async (job, ctx: WorkerContext) => {
    // P0: Rescue stuck outbox events (claimed but not completed within threshold)
    try {
      const rescued = await outboxEventRepository.rescueStuck(10);
      if (rescued > 0) {
        console.warn(`[outbox_poller] Rescued ${rescued} stuck outbox events`);
      }
    } catch (err) {
      console.error('[outbox_poller] Failed to rescue stuck events', err);
    }

    // Claim a batch of pending outbox events
    const events = await outboxEventRepository.claimBatch(10);

    for (const outboxEvent of events) {
      try {
        // Emit to EventBus
        const payload = outboxEvent.payload as any;
        await deps.eventBus.emit({
          id: outboxEvent.id,
          timestamp: outboxEvent.createdAt?.toISOString() || new Date().toISOString(),
          appId: outboxEvent.appId,
          category: payload.category || 'payment',
          providerId: payload.providerId,
          status: payload.status || 'success',
          latency: 0,
          cost: 0,
          decisionReason: outboxEvent.eventType,
          payload: payload.payload || payload,
          response: payload.response || null,
        });

        // Mark as completed
        await outboxEventRepository.complete(outboxEvent.id);
      } catch (err) {
        console.error(`[outbox_poller] Failed to process outbox event ${outboxEvent.id}`, err);
        await outboxEventRepository.fail(outboxEvent.id, String(err));
      }
    }
  };
}
