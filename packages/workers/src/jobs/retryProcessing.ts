import { JobProcessor, JobType } from '../types';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';

const ALL_TYPES: JobType[] = [
  'message_delivery',
  'payment_webhook',
  'provider_webhook',
  'provider_health',
  'event_processing',
  'retry_processing',
  'reconciliation',
];

export function createRetryProcessingProcessor(
  deps: JobDeps,
  queue: JobQueue,
): JobProcessor {
  return async () => {
    let reprocessed = 0;
    let permanent = 0;

    for (const type of ALL_TYPES) {
      const deadIds = await queue.deadJobs(type);
      for (const id of deadIds) {
        const job = await queue.getJob(id);
        if (!job) {
          await queue.removeDead(type, id);
          continue;
        }

        if ((job.deadRetries ?? 0) >= deps.config.retry.maxDeadRetries) {
          permanent += 1;
          continue;
        }

        await queue.enqueueDead(job);
        await queue.removeDead(type, id);
        reprocessed += 1;
      }
    }

    console.log(
      `[retry_processing] reprocessed=${reprocessed} permanent=${permanent}`,
    );
  };
}
