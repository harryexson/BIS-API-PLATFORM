import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { tenantIdNonBlank } from './tenant-id-check';

export const WEBHOOK_EVENT_STATUSES = ['received', 'processing', 'processed', 'failed'] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const WEBHOOK_CONSUMER_STATUSES = ['processing', 'processed', 'failed'] as const;
export type WebhookConsumerStatus = (typeof WEBHOOK_CONSUMER_STATUSES)[number];

/**
 * Phase 4 (gap register D7/C5/B8): the durable record of every inbound
 * provider webhook the gateway has accepted.
 *
 * DURABLE IDENTITY = (provider_id, provider_event_id), enforced by Postgres
 * through `uq_webhook_events_provider_event` — not by application code and
 * not by any in-memory map. Both columns are NOT NULL and CHECKed non-empty:
 * a webhook with no provider event id has no durable identity, so the
 * gateway rejects it (400) instead of storing something that could never be
 * de-duplicated.
 *
 * Lifecycle of `status` (the row-level summary):
 *   received   — persisted by the gateway (the uniqueness enforcement point);
 *                no consumer has started yet
 *   processing — at least one consumer job has claimed it
 *   processed  — every consumer listed in `expected_consumers` finished
 *   failed     — the most recent consumer attempt failed (retryable: a later
 *                attempt moves it back to processing)
 * The per-consumer truth lives in `webhook_event_consumers` below.
 *
 * Enqueue bookkeeping (`enqueued_at`, `enqueue_lease_until`, `enqueued_jobs`)
 * lets the gateway acknowledge only after a successful enqueue, lets a
 * provider redelivery take over the enqueue of an event whose first
 * delivery persisted but failed to enqueue, and lets the worker's recovery
 * sweeper re-enqueue anything stranded — without ever enqueueing the same
 * event twice concurrently (the lease is taken by a single conditional
 * UPDATE).
 *
 * `raw_body` + `signature` are kept so a re-enqueued job is byte-identical
 * to the original (the worker re-verifies the HMAC against them).
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: text('provider_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    appId: text('app_id'),
    tenantId: text('tenant_id'),
    eventType: text('event_type'),
    payload: jsonb('payload').notNull(),
    rawBody: text('raw_body').notNull(),
    signature: text('signature'),
    status: text('status').notNull().default('received'),
    expectedConsumers: text('expected_consumers').array().notNull().default(sql`'{}'::text[]`),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    enqueuedJobs: text('enqueued_jobs').array().notNull().default(sql`'{}'::text[]`),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    enqueueLeaseUntil: timestamp('enqueue_lease_until', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_webhook_events_provider_event').on(t.providerId, t.providerEventId),
    index('idx_webhook_events_status_received').on(t.status, t.receivedAt),
    index('idx_webhook_events_app_tenant').on(t.appId, t.tenantId),
    check('chk_webhook_events_provider_id_nonempty', sql`length(${t.providerId}) > 0`),
    check('chk_webhook_events_provider_event_id_nonempty', sql`length(${t.providerEventId}) > 0`),
    check(
      'chk_webhook_events_status',
      sql`${t.status} IN ('received', 'processing', 'processed', 'failed')`,
    ),
    tenantIdNonBlank('webhook_events', t.tenantId),
  ],
);

/**
 * Per-consumer processing state for a webhook event. The gateway enqueues
 * more than one job per delivery (payment_webhook AND provider_webhook), so
 * "has this event been processed?" is a per-consumer question.
 *
 * This is what replaces the worker's old Redis/memory `setNx` replay marker
 * (gap register B5), which was written BEFORE processing and never cleared,
 * so the first transient failure turned every retry into a permanent
 * "Replay detected". Here:
 *   - a claim is one atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE
 *     (status = 'failed' OR lease expired) RETURNING — so a failed attempt
 *     can be cleanly re-claimed, a crashed one can be re-claimed after its
 *     lease, and two concurrent workers can never both own it;
 *   - only a row in status 'processed' is a genuine replay;
 *   - `claim_token` rotates on every claim and fences complete()/fail(), so a
 *     worker that outlived its lease cannot overwrite the new owner's result.
 */
export const webhookEventConsumers = pgTable(
  'webhook_event_consumers',
  {
    webhookEventId: uuid('webhook_event_id')
      .notNull()
      .references(() => webhookEvents.id, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(1),
    claimToken: uuid('claim_token').notNull().defaultRandom(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_webhook_event_consumers', columns: [t.webhookEventId, t.consumer] }),
    check(
      'chk_webhook_event_consumers_status',
      sql`${t.status} IN ('processing', 'processed', 'failed')`,
    ),
  ],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type WebhookEventConsumer = typeof webhookEventConsumers.$inferSelect;
