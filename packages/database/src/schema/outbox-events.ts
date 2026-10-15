import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';

/**
 * Transactional outbox table.
 *
 * Producers write an outbox row in the SAME SQL statement as the business
 * state it announces (see webhook-events.ts `persistEffectsOnce` — one
 * statement, so one implicit transaction; never db.transaction(), which the
 * production neon-http driver cannot run, gap register D1). The outbox
 * poller worker then claims rows and dispatches them, at least once.
 *
 * Consumer state machine (Phase 5, gap register D10):
 *
 *   pending ──claim──▶ processing ──complete──▶ completed
 *      ▲                   │  │
 *      │   fail (attempts < max, after backoff)
 *      ├───────────────────┘  │
 *      │   lease went stale (claimed_at too old: the owner crashed)
 *      ├──────────────────────┘ (→ dead instead once attempts >= max)
 *      │
 *      └──replay (operator)── dead ◀── fail / stale with attempts >= max
 *
 * - `claimed_at` is when the CURRENT owner claimed (or last renewed) the row;
 *   staleness is judged from it — never from `created_at`, which says
 *   nothing about whether somebody is working on the row right now.
 * - `claim_token` fences every owner-side transition: a worker whose claim
 *   went stale and was re-claimed by someone else can no longer complete or
 *   fail the row.
 * - `attempts` counts claims (a crash counts as an attempt), so a poison row
 *   that keeps killing its worker still reaches `dead` instead of being
 *   rescued forever.
 * - `dead` is terminal until an operator replays it (listDead / replayDead).
 */
export const OUTBOX_STATUSES = ['pending', 'processing', 'completed', 'dead'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** Last error seen (kept across replays for audit until a new attempt overwrites it). */
    error: text('error'),
    /** Number of times the row has been claimed since it was created or last replayed. */
    attempts: integer('attempts').notNull().default(0),
    /** When the current owner claimed / last renewed the row. NULL unless status = 'processing'. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** Fencing token of the current owner. NULL unless status = 'processing'. */
    claimToken: uuid('claim_token'),
    /** A pending row is not claimable before this (retry backoff). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    /** How many times an operator has replayed this row out of `dead`. */
    replayCount: integer('replay_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_outbox_status').on(t.status),
    index('idx_outbox_created_at').on(t.createdAt),
    // Claim path: pending rows that are due, oldest first.
    index('idx_outbox_pending_due').on(t.nextAttemptAt, t.createdAt).where(sql`${t.status} = 'pending'`),
    // Rescue path: processing rows by claim age.
    index('idx_outbox_processing_claimed').on(t.claimedAt).where(sql`${t.status} = 'processing'`),
    // Dead-letter listing.
    index('idx_outbox_dead').on(t.deadAt).where(sql`${t.status} = 'dead'`),
    check('chk_outbox_status', sql`${t.status} IN ('pending', 'processing', 'completed', 'dead')`),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
