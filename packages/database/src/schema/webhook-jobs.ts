import { pgTable, uuid, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Durable fallback queue for gateway-enqueued worker jobs (inbound_message,
 * payment_webhook, provider_webhook).
 *
 * The gateway enqueues these directly into Redis when REDIS_URL is configured
 * (low latency). When it isn't, the gateway and worker are separate processes
 * with no shared memory, so an in-memory queue can't bridge them — this table
 * is that bridge: the gateway writes a row here, and webhookJobPoller (running
 * in the worker process) claims pending rows and re-enqueues them into the
 * worker's own live JobQueue for normal processing.
 */
export const webhookJobs = pgTable(
  'webhook_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    index('idx_webhook_jobs_status').on(t.status),
    index('idx_webhook_jobs_created_at').on(t.createdAt),
  ],
);

export type WebhookJob = typeof webhookJobs.$inferSelect;
export type NewWebhookJob = typeof webhookJobs.$inferInsert;
