import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';
import { WorkerConfig } from '../types';
import { Keys } from '../keys';
import { DistributedLock } from '../lock';
import { RateLimiter } from '../rateLimit';
import type { WebhookEventStore } from '../webhookEvents';
import type { OutboxStore, OutboxDispatcher } from './outboxPoller';
import type { PaymentReconciliationStore } from './paymentReconciliation';

export interface JobDeps {
  registry: ProviderRegistry;
  routing: RoutingEngine;
  eventBus: EventBus;
  lock: DistributedLock;
  rateLimiter: RateLimiter;
  config: WorkerConfig;
  keys: Keys;
  /**
   * Durable webhook store (webhook_events / webhook_event_consumers).
   * Defaults to @company/database's webhookEventRepository; injectable so
   * tests can bind the same repository to a real Postgres.
   */
  webhookEvents?: WebhookEventStore;
  /**
   * Phase 5: transactional-outbox store (outbox_events). Defaults to
   * @company/database's outboxEventRepository; injectable for real-Postgres tests.
   */
  outbox?: OutboxStore;
  /** Phase 5: performs an outbox row's effect. Defaults to EventBus.emitOrThrow. */
  outboxDispatch?: OutboxDispatcher;
  /**
   * Phase 6: payment reconciliation store (transactions). Defaults to
   * @company/database's transactionRepository; injectable for real-Postgres tests.
   */
  paymentReconciliation?: PaymentReconciliationStore;
}

export class NeonWriteError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'NeonWriteError';
  }
}
