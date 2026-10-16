import { and, asc, count, desc, eq, lte, sql, type SQL } from 'drizzle-orm';
import { inLockedCandidates } from './locking';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { getDb } from '../connection';
import { outboxEvents, type OutboxEvent, type NewOutboxEvent } from '../schema';

// Any drizzle Postgres handle: neon-http in production, postgres-js in the
// real-Postgres integration tests. Same PgDialect, so identical SQL.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

/** A claimed outbox row: `claimToken` and `claimedAt` are always set. */
export type ClaimedOutboxEvent = OutboxEvent & { claimToken: string; claimedAt: Date };

// Policy constants live in a DB-free module so the simulation's
// '@company/database' mock can share them verbatim (see outbox-policy.ts).
import { DEFAULT_OUTBOX_RETRY_POLICY, DEFAULT_OUTBOX_STALE_AFTER_MS, type OutboxRetryPolicy } from '../outbox-policy';
export { DEFAULT_OUTBOX_RETRY_POLICY, DEFAULT_OUTBOX_STALE_AFTER_MS, type OutboxRetryPolicy };

export interface OutboxRescueResult {
  /** Stale rows returned to `pending` for another attempt. */
  requeued: OutboxEvent[];
  /** Stale rows that had already used every attempt and were dead-lettered instead. */
  deadLettered: OutboxEvent[];
}

export interface OutboxDeadFilter {
  appId?: string;
  eventType?: string;
}

const secs = (ms: number) => Math.max(0, ms) / 1000;

/** `now() - <ms>` on the DATABASE clock (no app/DB clock skew). */
const nowMinus = (ms: number) => sql`now() - make_interval(secs => ${secs(ms)}::double precision)`;

/**
 * Transactional-outbox consumer store (gap register D10). Factory so the
 * exact SQL runs against a real Postgres in tests; production uses the
 * `outboxEventRepository` singleton bound to getDb().
 *
 * Every state transition is ONE SQL statement — no db.transaction(), which
 * the production neon-http driver cannot run (gap register D1). Concurrency
 * safety comes from Postgres row locks: claims and rescues select their
 * candidates with FOR UPDATE SKIP LOCKED and re-check the status predicate
 * in the outer UPDATE, and every owner-side transition is fenced by the
 * row's claim_token.
 */
export function createOutboxEventRepository(dbProvider: () => AnyPgDb) {
  const repo = {
    async create(data: NewOutboxEvent): Promise<OutboxEvent> {
      const db = dbProvider();
      const rows = await db.insert(outboxEvents).values(data).returning();
      return rows[0];
    },

    async findById(id: string): Promise<OutboxEvent | undefined> {
      const db = dbProvider();
      const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)).limit(1);
      return rows[0];
    },

    /**
     * Claim up to `batchLimit` due pending rows — ONE statement:
     *
     *   UPDATE outbox_events
     *      SET status = 'processing', claimed_at = now(),
     *          claim_token = gen_random_uuid(), attempts = attempts + 1
     *    WHERE id = ANY(ARRAY(SELECT id FROM outbox_events
     *                  WHERE status = 'pending' AND next_attempt_at <= now()
     *                  ORDER BY created_at LIMIT $batchLimit
     *                  FOR UPDATE SKIP LOCKED))      -- InitPlan: runs once
     *      AND status = 'pending'
     *   RETURNING *
     *
     * Exactly the rows returned are claimed; every other row stays
     * `pending`. (The old version flipped EVERY pending row to `processing`
     * and then sliced the result in JS, stranding all but `batchLimit` of
     * them.) ANY(ARRAY(...)) rather than IN (...) is deliberate — see
     * inLockedCandidates. SKIP LOCKED lets concurrent claimers on any number of replicas
     * take disjoint batches without waiting on each other; the outer
     * `status = 'pending'` re-check (re-evaluated by Postgres on the locked,
     * latest row version) makes a double claim impossible even if a row
     * changed between the sub-select and the update.
     */
    async claimBatch(batchLimit: number = 10): Promise<ClaimedOutboxEvent[]> {
      const db = dbProvider();
      const limit = Math.max(0, Math.floor(batchLimit));
      if (limit === 0) return [];
      const candidates = db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.nextAttemptAt, sql`now()`)))
        .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      const rows = await db
        .update(outboxEvents)
        .set({
          status: 'processing',
          claimedAt: sql`now()`,
          claimToken: sql`gen_random_uuid()`,
          attempts: sql`${outboxEvents.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(inLockedCandidates(outboxEvents.id, candidates), eq(outboxEvents.status, 'pending')))
        .returning();
      // UPDATE ... RETURNING has no ORDER BY; keep FIFO for the caller.
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      return rows as ClaimedOutboxEvent[];
    },

    /**
     * Heartbeat + fence: bump claimed_at for a row this owner still holds.
     * Returns false if the claim was lost (rescued after going stale, and
     * possibly re-claimed by another worker) — the caller must then NOT
     * dispatch the row.
     */
    async renewClaim(id: string, claimToken: string): Promise<boolean> {
      const db = dbProvider();
      const rows = await db
        .update(outboxEvents)
        .set({ claimedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(outboxEvents.id, id), eq(outboxEvents.claimToken, claimToken), eq(outboxEvents.status, 'processing')))
        .returning({ id: outboxEvents.id });
      return rows.length > 0;
    },

    /** Mark dispatched. Fenced by claim token: false (and nothing changed) if this owner lost the claim. */
    async complete(id: string, claimToken: string): Promise<boolean> {
      const db = dbProvider();
      const rows = await db
        .update(outboxEvents)
        .set({
          status: 'completed',
          processedAt: sql`now()`,
          claimToken: null,
          claimedAt: null,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(outboxEvents.id, id), eq(outboxEvents.claimToken, claimToken), eq(outboxEvents.status, 'processing')))
        .returning({ id: outboxEvents.id });
      return rows.length > 0;
    },

    /**
     * Record a failed dispatch attempt — ONE statement that either schedules
     * a retry (`pending`, next_attempt_at = now() + backoff) or, once
     * `attempts >= maxAttempts`, dead-letters the row. Never a silent
     * terminal state: a dead row is listable and replayable. Fenced by claim
     * token; returns the row's new status, or null if the claim was lost.
     */
    async fail(
      id: string,
      claimToken: string,
      error: string,
      policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
    ): Promise<'pending' | 'dead' | null> {
      const db = dbProvider();
      const exhausted = sql`${outboxEvents.attempts} >= ${policy.maxAttempts}`;
      const backoffSecs = sql`LEAST(${secs(policy.baseDelayMs)}::double precision * power(2, GREATEST(${outboxEvents.attempts} - 1, 0)), ${secs(policy.maxDelayMs)}::double precision)`;
      const rows = await db
        .update(outboxEvents)
        .set({
          status: sql`CASE WHEN ${exhausted} THEN 'dead' ELSE 'pending' END`,
          deadAt: sql`CASE WHEN ${exhausted} THEN now() ELSE NULL END`,
          nextAttemptAt: sql`CASE WHEN ${exhausted} THEN ${outboxEvents.nextAttemptAt} ELSE now() + make_interval(secs => ${backoffSecs}) END`,
          claimToken: null,
          claimedAt: null,
          error: error.slice(0, 4000),
          updatedAt: sql`now()`,
        })
        .where(and(eq(outboxEvents.id, id), eq(outboxEvents.claimToken, claimToken), eq(outboxEvents.status, 'processing')))
        .returning({ status: outboxEvents.status });
      return (rows[0]?.status as 'pending' | 'dead' | undefined) ?? null;
    },

    /**
     * Stale-claim rescue — ONE statement. A `processing` row whose claim is
     * older than `staleAfterMs` belonged to a worker that died (or hung past
     * its handler timeout and every heartbeat): it goes back to `pending`
     * with its claim token cleared (so the old owner can no longer complete
     * or fail it), or to `dead` if it has already used `maxAttempts` claims.
     *
     * Staleness is judged from claimed_at — when the CURRENT owner claimed or
     * last renewed the row — not created_at (the old bug: a row created long
     * ago but claimed a second ago looked stale and was yanked from a live
     * owner). COALESCE(claimed_at, created_at) only matters for rows claimed
     * by pre-Phase-5 code, which never set claimed_at.
     */
    async rescueStale(opts: {
      staleAfterMs?: number;
      maxAttempts?: number;
      limit?: number;
    } = {}): Promise<OutboxRescueResult> {
      const db = dbProvider();
      const staleAfterMs = opts.staleAfterMs ?? DEFAULT_OUTBOX_STALE_AFTER_MS;
      const maxAttempts = opts.maxAttempts ?? DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts;
      const limit = Math.max(0, Math.floor(opts.limit ?? 100));
      if (limit === 0) return { requeued: [], deadLettered: [] };
      const stale = and(
        eq(outboxEvents.status, 'processing'),
        lte(sql`COALESCE(${outboxEvents.claimedAt}, ${outboxEvents.createdAt})`, nowMinus(staleAfterMs)),
      ) as SQL;
      const candidates = db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(stale)
        .orderBy(asc(outboxEvents.claimedAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      const exhausted = sql`${outboxEvents.attempts} >= ${maxAttempts}`;
      const rows = await db
        .update(outboxEvents)
        .set({
          status: sql`CASE WHEN ${exhausted} THEN 'dead' ELSE 'pending' END`,
          deadAt: sql`CASE WHEN ${exhausted} THEN now() ELSE NULL END`,
          nextAttemptAt: sql`now()`,
          claimToken: null,
          claimedAt: null,
          error: sql`'claim went stale (worker presumed crashed) after attempt ' || ${outboxEvents.attempts} || COALESCE('; previous error: ' || ${outboxEvents.error}, '')`,
          updatedAt: sql`now()`,
        })
        .where(and(inLockedCandidates(outboxEvents.id, candidates), stale))
        .returning();
      return {
        requeued: rows.filter((r) => r.status === 'pending'),
        deadLettered: rows.filter((r) => r.status === 'dead'),
      };
    },

    /** Dead letters, newest first. */
    async listDead(opts: OutboxDeadFilter & { limit?: number } = {}): Promise<OutboxEvent[]> {
      const db = dbProvider();
      const filters = [eq(outboxEvents.status, 'dead')];
      if (opts.appId) filters.push(eq(outboxEvents.appId, opts.appId));
      if (opts.eventType) filters.push(eq(outboxEvents.eventType, opts.eventType));
      return db
        .select()
        .from(outboxEvents)
        .where(and(...filters))
        .orderBy(desc(outboxEvents.deadAt), desc(outboxEvents.createdAt))
        .limit(Math.min(Math.max(1, opts.limit ?? 50), 500));
    },

    /**
     * Operator replay of ONE dead letter — ONE conditional statement:
     *
     *   UPDATE outbox_events SET status = 'pending', attempts = 0, ...
     *    WHERE id = $id AND status = 'dead' RETURNING *
     *
     * Only a `dead` row can be replayed, so:
     * - two racing replays of the same row: exactly one gets the row back,
     *   the other gets undefined — one re-dispatch, not two;
     * - a row that is `completed` (or pending/processing) is refused, so a
     *   replay can never re-dispatch something already delivered or in flight.
     * Policy: the attempt budget is RESET (the operator is asserting the
     * cause was fixed, so the row gets a full set of retries); the history
     * is preserved in replay_count and the last error is kept until a new
     * attempt overwrites it. The row keeps its id, which is the idempotency
     * key the dispatcher hands downstream, so a receiver that already saw it
     * can de-duplicate.
     */
    async replayDead(id: string): Promise<OutboxEvent | undefined> {
      const db = dbProvider();
      const rows = await db
        .update(outboxEvents)
        .set({
          status: 'pending',
          attempts: 0,
          nextAttemptAt: sql`now()`,
          deadAt: null,
          replayCount: sql`${outboxEvents.replayCount} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, 'dead')))
        .returning();
      return rows[0];
    },

    /** Replay up to `limit` dead letters matching the filter (same guarantees as replayDead). */
    async replayDeadBatch(opts: OutboxDeadFilter & { limit?: number } = {}): Promise<OutboxEvent[]> {
      const db = dbProvider();
      const filters = [eq(outboxEvents.status, 'dead')];
      if (opts.appId) filters.push(eq(outboxEvents.appId, opts.appId));
      if (opts.eventType) filters.push(eq(outboxEvents.eventType, opts.eventType));
      const where = and(...filters) as SQL;
      const candidates = db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(where)
        .orderBy(asc(outboxEvents.deadAt))
        .limit(Math.min(Math.max(1, opts.limit ?? 100), 1000))
        .for('update', { skipLocked: true });
      return db
        .update(outboxEvents)
        .set({
          status: 'pending',
          attempts: 0,
          nextAttemptAt: sql`now()`,
          deadAt: null,
          replayCount: sql`${outboxEvents.replayCount} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(inLockedCandidates(outboxEvents.id, candidates), where))
        .returning();
    },

    async countByStatus(): Promise<Record<string, number>> {
      const db = dbProvider();
      const rows = await db
        .select({ status: outboxEvents.status, n: sql<number>`count(*)::int` })
        .from(outboxEvents)
        .groupBy(outboxEvents.status);
      const out: Record<string, number> = { pending: 0, processing: 0, completed: 0, dead: 0 };
      for (const r of rows) out[r.status] = Number(r.n);
      return out;
    },

    async findPending(): Promise<OutboxEvent[]> {
      const db = dbProvider();
      return db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.status, 'pending'))
        .orderBy(outboxEvents.createdAt);
    },

    async count(): Promise<number> {
      const db = dbProvider();
      const rows = await db.select({ value: count() }).from(outboxEvents);
      return rows[0]?.value ?? 0;
    },
  };
  return repo;
}

export type OutboxEventRepository = ReturnType<typeof createOutboxEventRepository>;

export const outboxEventRepository: OutboxEventRepository = createOutboxEventRepository(
  () => getDb() as unknown as AnyPgDb,
);
