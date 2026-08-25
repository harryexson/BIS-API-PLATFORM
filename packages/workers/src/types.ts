import { randomUUID } from 'crypto';
import { KVStore } from './store';

export type JobType =
  | 'message_delivery'
  | 'payment_webhook'
  | 'provider_webhook'
  | 'provider_health'
  | 'event_processing'
  | 'retry_processing'
  | 'reconciliation';

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
  };
}

export function newJobId(): string {
  return `job_${randomUUID()}`;
}
