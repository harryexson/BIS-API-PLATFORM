import { JobProcessor, JobType } from '../types';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';
import { eventRepository, auditLogRepository } from '@company/database';

const ALL_TYPES: JobType[] = [
  'message_delivery',
  'payment_webhook',
  'provider_webhook',
  'provider_health',
  'event_processing',
  'retry_processing',
  'reconciliation',
  'inbound_message',
  'outbox_poller',
  'receipt_pipeline',
  'keyword_response_delivery',
];

export function createReconciliationProcessor(
  deps: JobDeps,
  queue: JobQueue,
): JobProcessor {
  return async () => {
    const owner = `reconciliation_${Math.random().toString(36).slice(2, 8)}`;
    const ttl = deps.config.retry.maxDelayMs;

    await deps.lock.withLock('reconciliation', owner, ttl, async () => {
      const eventsByCategory = await eventRepository.countByCategory().catch(() => ({}));
      const totalEvents = Object.values(eventsByCategory).reduce((a, b) => a + b, 0);

      const deadLetters: Record<string, number> = {};
      for (const type of ALL_TYPES) {
        deadLetters[type] = await queue.deadCount(type);
      }

      const report = {
        generatedAt: new Date().toISOString(),
        neon: { totalEvents, eventsByCategory },
        redis: { deadLetters },
        note: 'Neon is the source of truth for durable state; Redis holds ephemeral queue/locks.',
      };

      try {
        await auditLogRepository.create({
          action: 'reconciliation',
          resource: 'system',
          resourceId: 'workers',
          details: JSON.stringify(report),
        });
      } catch (err) {
        console.error('[reconciliation] Neon write failed', err);
      }

      deps.eventBus.emit({
        id: `recon_${Date.now()}`,
        timestamp: new Date().toISOString(),
        appId: 'system',
        category: 'other' as const,
        providerId: 'workers',
        status: 'success' as const,
        latency: 0,
        cost: 0,
        decisionReason: 'reconciliation_completed',
        payload: report,
        response: null,
      });
    });
  };
}
