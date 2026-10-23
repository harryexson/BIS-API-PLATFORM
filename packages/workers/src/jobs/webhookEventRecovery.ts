import { logger } from '@company/observability';
import { webhookEventRepository } from '@company/database';
import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';
import { recoverStrandedWebhookEvents } from '../webhookEvents';

/**
 * Phase 4: periodic sweep of webhook_events for rows that were durably
 * persisted but never reached a consumer — the gateway's enqueue failed
 * (Redis down, backpressure) or the gateway crashed between persist and
 * enqueue, or the job went into a store this worker cannot see. Each such
 * row is re-enqueued into THIS worker's queue. Unlike the old in-memory
 * dedup map and Redis replay markers, the rows it reads survive any
 * gateway/worker/Redis restart.
 */
export function createWebhookEventRecoveryProcessor(deps: JobDeps, queue: JobQueue): JobProcessor {
  return async () => {
    const store = deps.webhookEvents ?? webhookEventRepository;
    const { recovered, failed } = await recoverStrandedWebhookEvents(
      store,
      (type, payload) => queue.enqueue(type, payload),
      { staleAfterMs: deps.config.webhookStaleEnqueueMs },
    );
    if (recovered > 0 || failed > 0) {
      logger.warn('re-enqueued stranded webhook events (failures retry next sweep)', {
        operation: 'webhook_event_recovery',
        status: failed > 0 ? 'partial' : 'recovered',
        recovered,
        failed,
      });
    }
  };
}
