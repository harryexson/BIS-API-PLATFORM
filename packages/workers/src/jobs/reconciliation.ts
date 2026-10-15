import { JobProcessor, JobType } from '../types';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';
import { eventRepository, auditLogRepository, transactionRepository } from '@company/database';
import {
  resolvePaymentReconciliationConfig,
  runPaymentReconciliationOnce,
  type PaymentReconciliationReport,
  type PaymentReconciliationStore,
} from './paymentReconciliation';

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
  'webhook_job_poller',
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

      // Phase 6 (gap register D4 / PHASE3-02): reconcile payments whose
      // outcome is unknown or stuck. Read-only provider status checks where
      // an adapter supports one, otherwise escalation to the operator list —
      // NEVER a charge retry (see paymentReconciliation.ts).
      let payments: PaymentReconciliationReport | { error: string };
      try {
        payments = await runPaymentReconciliationOnce(
          deps,
          deps.paymentReconciliation ?? (transactionRepository as unknown as PaymentReconciliationStore),
          resolvePaymentReconciliationConfig(deps.config.paymentReconciliation),
        );
      } catch (err) {
        console.error('[reconciliation] payment reconciliation failed', err);
        payments = { error: err instanceof Error ? err.message : String(err) };
      }

      const report = {
        generatedAt: new Date().toISOString(),
        neon: { totalEvents, eventsByCategory },
        redis: { deadLetters },
        payments,
        note: 'Neon is the source of truth for durable state; Redis holds ephemeral queue/locks. Payments with an unknown outcome are checked read-only with the provider where an adapter supports it, otherwise escalated to requires_reconciliation (GET /api/dashboard/payments/reconciliation) — never re-charged.',
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
