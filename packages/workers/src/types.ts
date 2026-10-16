import { randomUUID } from 'crypto';
import { KVStore } from './store';

export type JobType =
  | 'message_delivery'
  | 'payment_webhook'
  | 'provider_webhook'
  | 'provider_health'
  | 'event_processing'
  | 'retry_processing'
  | 'reconciliation'
  | 'inbound_message'
  | 'outbox_poller'
  | 'receipt_pipeline'
  | 'keyword_response_delivery'
  | 'webhook_job_poller'
  | 'webhook_event_recovery';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface JobPayload {
  [key: string]: any;
}

export interface Job {
  id: string;
  type: JobType;
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  runAt: number;
  lastError?: string;
  idempotencyKey?: string;
  deadRetries?: number;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  maxAttempts?: number;
  delayMs?: number;
  runAt?: number;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  maxDeadRetries: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface WorkerConfig {
  redisUrl: string;
  concurrency: number;
  queuePrefix: string;
  idempotencyTtlMs: number;
  pollIntervalMs: number;
  reconciliationIntervalMs: number;
  providerHealthIntervalMs: number;
  retryProcessingIntervalMs: number;
  retry: RetryConfig;
  rateLimit: RateLimitConfig;
  /** Max combined ready+delayed jobs allowed per job type before enqueue()
   * rejects with QueueBackpressureError instead of accepting more work the
   * system has no near-term capacity to process. */
  maxQueueDepth: number;
  /** Phase 4: lease a worker holds on a webhook_event_consumers claim (default 5 min). */
  webhookConsumerLeaseMs?: number;
  /** Phase 4: how often the worker sweeps webhook_events for stranded rows (default 30s). */
  webhookRecoveryIntervalMs?: number;
  /** Phase 4: an enqueued row still 'received' after this long is re-enqueued (default 10 min). */
  webhookStaleEnqueueMs?: number;
  /** Phase 6: payment reconciliation thresholds (see jobs/paymentReconciliation.ts). */
  paymentReconciliation?: Partial<{
    staleAfterMs: number;
    recheckAfterMs: number;
    escalateAfterMs: number;
    batchSize: number;
  }>;
  /** Phase 5: transactional-outbox consumer tuning (see jobs/outboxPoller.ts). */
  outbox?: Partial<{
    batchSize: number;
    staleAfterMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    dispatchTimeoutMs: number;
    rescueLimit: number;
  }>;
}

export interface WorkerContext {
  store: KVStore;
  signal: AbortSignal;
}

export type JobProcessor = (job: Job, ctx: WorkerContext) => Promise<void>;

export function createWorkerConfig(): WorkerConfig {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  return {
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    concurrency: num(process.env.WORKER_CONCURRENCY, 5),
    queuePrefix: process.env.WORKER_QUEUE_PREFIX || 'bis',
    idempotencyTtlMs: num(process.env.IDEMPOTENCY_TTL_HOURS, 24) * 3_600_000,
    pollIntervalMs: num(process.env.WORKER_POLL_MS, 500),
    reconciliationIntervalMs: num(process.env.RECONCILIATION_INTERVAL_MS, 300_000),
    providerHealthIntervalMs: num(process.env.PROVIDER_HEALTH_INTERVAL_MS, 60_000),
    retryProcessingIntervalMs: num(process.env.RETRY_PROCESSING_INTERVAL_MS, 30_000),
    retry: {
      maxAttempts: num(process.env.WORKER_MAX_ATTEMPTS, 5),
      baseDelayMs: num(process.env.WORKER_RETRY_BASE_MS, 1000),
      maxDelayMs: num(process.env.WORKER_RETRY_MAX_MS, 300_000),
      factor: num(process.env.WORKER_RETRY_FACTOR, 2),
      maxDeadRetries: num(process.env.WORKER_MAX_DEAD_RETRIES, 3),
    },
    rateLimit: {
      windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
      maxRequests: num(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
    },
    maxQueueDepth: num(process.env.QUEUE_MAX_DEPTH, 10_000),
    webhookConsumerLeaseMs: num(process.env.WEBHOOK_CONSUMER_LEASE_MS, 5 * 60_000),
    webhookRecoveryIntervalMs: num(process.env.WEBHOOK_RECOVERY_INTERVAL_MS, 30_000),
    webhookStaleEnqueueMs: num(process.env.WEBHOOK_STALE_ENQUEUE_MS, 10 * 60_000),
    paymentReconciliation: {
      staleAfterMs: num(process.env.PAYMENT_RECONCILIATION_STALE_MS, 15 * 60_000),
      recheckAfterMs: num(process.env.PAYMENT_RECONCILIATION_RECHECK_MS, 5 * 60_000),
      escalateAfterMs: num(process.env.PAYMENT_RECONCILIATION_ESCALATE_MS, 60 * 60_000),
      batchSize: num(process.env.PAYMENT_RECONCILIATION_BATCH_SIZE, 100),
    },
    outbox: {
      batchSize: num(process.env.OUTBOX_BATCH_SIZE, 10),
      staleAfterMs: num(process.env.OUTBOX_STALE_AFTER_MS, 5 * 60_000),
      maxAttempts: num(process.env.OUTBOX_MAX_ATTEMPTS, 10),
      baseDelayMs: num(process.env.OUTBOX_RETRY_BASE_MS, 1_000),
      maxDelayMs: num(process.env.OUTBOX_RETRY_MAX_MS, 5 * 60_000),
      dispatchTimeoutMs: num(process.env.OUTBOX_DISPATCH_TIMEOUT_MS, 30_000),
      rescueLimit: num(process.env.OUTBOX_RESCUE_LIMIT, 100),
    },
  };
}

export function newJobId(): string {
  return `job_${randomUUID()}`;
}
