import { JobProcessor, JobType } from '../types';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';
import { eventRepository, auditLogRepository, transactionRepository } from '@company/database';

// A payment stuck in 'pending'/'processing'/'unknown' this long is worth
// flagging — long enough that a normal async settlement (e.g.
// Flutterwave's mobile-money legs, a webhook still in flight) isn't a
// false positive, short enough that a genuinely stuck charge doesn't sit
// unnoticed for days. Configurable since what counts as "stuck" is a
// business call, not a fixed platform constant.
const STALE_TRANSACTION_THRESHOLD_MS = Number(process.env.RECONCILIATION_STALE_THRESHOLD_MS) || 60 * 60_000;

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
      const eventsByCategory = await eventRepository.countByCategory('system').catch(() => ({}));
      const totalEvents = Object.values(eventsByCategory).reduce((a, b) => a + b, 0);

      const deadLetters: Record<string, number> = {};
      for (const type of ALL_TYPES) {
        deadLetters[type] = await queue.deadCount(type);
      }

      // P0: Real payment reconciliation — this job previously reported
      // system/queue health only, despite its name; it never actually
      // looked at whether payments themselves had settled. Detection-only
      // (see transactionRepository.findStaleUnresolved's own comment for
      // why auto-resolving isn't attempted): each stale transaction is a
      // real, unresolved discrepancy an operator needs to chase down
      // directly with the provider, not something this platform can
      // safely guess the outcome of from its own state alone.
      const staleTransactions = await transactionRepository
        .findStaleUnresolved(STALE_TRANSACTION_THRESHOLD_MS)
        .catch(() => []);

      const report = {
        generatedAt: new Date().toISOString(),
        neon: { totalEvents, eventsByCategory },
        redis: { deadLetters },
        payments: {
          staleThresholdMs: STALE_TRANSACTION_THRESHOLD_MS,
          staleCount: staleTransactions.length,
          stale: staleTransactions.map((t) => ({
            id: t.id,
            appId: t.appId,
            providerId: t.providerId,
            providerTransactionId: t.providerTransactionId,
            status: t.status,
            amount: t.amount,
            currency: t.currency,
            updatedAt: t.updatedAt,
          })),
        },
        note: 'Neon is the source of truth for durable state; Redis holds ephemeral queue/locks.',
      };

      if (staleTransactions.length > 0) {
        console.warn(
          `[reconciliation] ${staleTransactions.length} transaction(s) stuck unresolved for over ${STALE_TRANSACTION_THRESHOLD_MS / 60_000} minutes — see the audit log / GET /api/dashboard/reconciliation for detail`,
        );
      }

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

      await deps.eventBus.emit({
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
