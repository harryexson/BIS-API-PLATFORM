import { JobProcessor, JobType } from '../types';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';
import { webhookJobRepository } from '@company/database';

/**
 * Bridges gateway-enqueued webhook jobs (inbound_message, payment_webhook,
 * provider_webhook) from Postgres into this worker's live queue.
 *
 * The gateway enqueues directly into Redis when REDIS_URL is configured. When
 * it isn't, the gateway and worker are separate processes with no shared
 * memory — see packages/database/src/schema/webhook-jobs.ts for why a
 * database row is the only way to bridge them without Redis. This poller
 * claims those rows and re-enqueues them here so the normal registered
 * processors (already wired up via registerAllProcessors) handle them exactly
 * as if they'd arrived over Redis.
 */
export function createWebhookJobPollerProcessor(
  deps: JobDeps,
  queue: JobQueue,
): JobProcessor {
  return async () => {
    try {
      const rescued = await webhookJobRepository.rescueStuck(10);
      if (rescued > 0) {
        console.warn(`[webhook_job_poller] Rescued ${rescued} stuck webhook jobs`);
      }
    } catch (err) {
      console.error('[webhook_job_poller] Failed to rescue stuck jobs', err);
    }

    const jobs = await webhookJobRepository.claimBatch(10);

    for (const row of jobs) {
      try {
        await queue.enqueue(row.jobType as JobType, row.payload as Record<string, unknown>);
        await webhookJobRepository.complete(row.id);
      } catch (err) {
        console.error(`[webhook_job_poller] Failed to bridge webhook job ${row.id}`, err);
        await webhookJobRepository.fail(row.id, String(err));
      }
    }
  };
}
