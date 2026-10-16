import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { getDb } from '../connection';
import { inLockedCandidates } from './locking';
import {
  webhookEvents,
  webhookEventConsumers,
  type WebhookEvent,
  type WebhookEventConsumer,
} from '../schema';

// Any drizzle Postgres handle: neon-http in production, postgres-js in the
// real-Postgres integration tests. Same PgDialect, so identical SQL.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `now() + <ms>` evaluated on the DATABASE clock (no app/DB clock skew). */
function nowPlus(ms: number) {
  const secs = Math.max(0, ms) / 1000;
  return sql`now() + make_interval(secs => ${secs}::double precision)`;
}

export interface WebhookEventClaimInput {
  providerId: string;
  providerEventId: string;
  appId?: string | null;
  tenantId?: string | null;
  eventType?: string | null;
  payload: unknown;
  rawBody: string;
  signature?: string | null;
  /** Job types that must ALL finish before the row counts as `processed`. */
  expectedConsumers: string[];
  /**
   * The inserting caller owns the enqueue for this long. A redelivery (or
   * the recovery sweeper) can only take the enqueue over once it lapses.
   */
  enqueueLeaseMs: number;
}

export type WebhookEventClaimResult =
  /** First durable sighting of (provider_id, provider_event_id): this caller inserted the row. */
  | { claimed: true; event: WebhookEvent }
  /** The unique index already held this identity; `existing` is the row read immediately afterwards. */
  | { claimed: false; existing: WebhookEvent | undefined };

export type WebhookConsumerClaimResult =
  | { claimed: true; consumer: WebhookEventConsumer }
  | { claimed: false; existing: WebhookEventConsumer | undefined };

/**
 * Durable inbound-webhook store (gap register D7). Factory so the exact SQL
 * runs against a real Postgres in tests; production uses the
 * `webhookEventRepository` singleton bound to getDb().
 *
 * Every state transition below is ONE SQL statement — no db.transaction(),
 * which the production neon-http driver cannot run at all (gap register D1).
 * Atomicity comes from Postgres itself: the unique index for receipt, the
 * primary key + conditional ON CONFLICT DO UPDATE for consumer claims, and
 * conditional UPDATE ... WHERE ... RETURNING for leases.
 */
export function createWebhookEventRepository(dbProvider: () => AnyPgDb) {
  const repo = {
    /**
     * THE uniqueness enforcement point of the webhook pipeline:
     *
     *   INSERT INTO webhook_events (...) VALUES (...)
     *   ON CONFLICT (provider_id, provider_event_id) DO NOTHING
     *   RETURNING *
     *
     * A row back ⇒ first delivery. No row ⇒ Postgres's unique index
     * (uq_webhook_events_provider_event) already holds this identity —
     * whether from an earlier delivery, a delivery to a different gateway
     * replica, or a delivery that arrived before this process restarted.
     * Concurrent duplicates are serialised by the index itself, so exactly
     * one caller can ever get a row back.
     */
    async claim(input: WebhookEventClaimInput): Promise<WebhookEventClaimResult> {
      const db = dbProvider();
      const rows = await db
        .insert(webhookEvents)
        .values({
          providerId: input.providerId,
          providerEventId: input.providerEventId,
          appId: input.appId ?? null,
          tenantId: input.tenantId ?? null,
          eventType: input.eventType ?? null,
          payload: input.payload ?? {},
          rawBody: input.rawBody,
          signature: input.signature ?? null,
          status: 'received',
          expectedConsumers: input.expectedConsumers,
          enqueueLeaseUntil: nowPlus(input.enqueueLeaseMs),
        })
        .onConflictDoNothing({ target: [webhookEvents.providerId, webhookEvents.providerEventId] })
        .returning();
      if (rows[0]) return { claimed: true, event: rows[0] };
      const existing = await repo.findByProviderEvent(input.providerId, input.providerEventId);
      return { claimed: false, existing };
    },

    async findById(id: string): Promise<WebhookEvent | undefined> {
      const db = dbProvider();
      const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
      return rows[0];
    },

    async findByProviderEvent(providerId: string, providerEventId: string): Promise<WebhookEvent | undefined> {
      const db = dbProvider();
      const rows = await db
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.providerId, providerId), eq(webhookEvents.providerEventId, providerEventId)))
        .limit(1);
      return rows[0];
    },

    /**
     * Take over the enqueue of a persisted-but-never-enqueued event (its
     * first delivery's enqueue failed, or that gateway died mid-request).
     * Succeeds only if nobody holds a live lease, so concurrent redeliveries
     * cannot both enqueue it.
     */
    async acquireEnqueueLease(id: string, leaseMs: number): Promise<WebhookEvent | undefined> {
      const db = dbProvider();
      const rows = await db
        .update(webhookEvents)
        .set({ enqueueLeaseUntil: nowPlus(leaseMs), updatedAt: sql`now()` })
        .where(
          and(
            eq(webhookEvents.id, id),
            isNull(webhookEvents.enqueuedAt),
            or(isNull(webhookEvents.enqueueLeaseUntil), lte(webhookEvents.enqueueLeaseUntil, sql`now()`)),
          ),
        )
        .returning();
      return rows[0];
    },

    /** Record a completed enqueue and release the lease. `jobs` is the full set enqueued so far. */
    async markEnqueued(id: string, jobs: string[]): Promise<boolean> {
      const db = dbProvider();
      const rows = await db
        .update(webhookEvents)
        .set({ enqueuedAt: sql`now()`, enqueuedJobs: jobs, enqueueLeaseUntil: null, updatedAt: sql`now()` })
        .where(eq(webhookEvents.id, id))
        .returning({ id: webhookEvents.id });
      return rows.length > 0;
    },

    /** Enqueue failed: release the lease immediately so the provider's retry can take over. */
    async releaseEnqueueLease(id: string, jobsEnqueuedSoFar: string[], error: string): Promise<void> {
      const db = dbProvider();
      await db
        .update(webhookEvents)
        .set({
          enqueueLeaseUntil: null,
          enqueuedJobs: jobsEnqueuedSoFar,
          lastError: error.slice(0, 2000),
          updatedAt: sql`now()`,
        })
        .where(eq(webhookEvents.id, id));
    },

    /**
     * Recovery sweep (worker side): atomically lease up to `limit` events
     * that belong to one of `consumers` and are stranded, i.e. either
     *   - never enqueued and nobody holds a live enqueue lease, or
     *   - enqueued more than `staleAfterMs` ago but still `received` (no
     *     consumer ever picked the job up — e.g. it went into a store the
     *     worker cannot see, or the store lost it).
     * Phase 5 fix: the candidate set is fed in through inLockedCandidates
     * (ANY(ARRAY(...)), an InitPlan) instead of IN (...), which Postgres can
     * plan as a re-scanned semi-join that leases MORE than `limit` rows.
     * One statement; FOR UPDATE SKIP LOCKED keeps concurrent sweepers on
     * different replicas from leasing the same rows.
     */
    async claimStrandedForEnqueue(opts: {
      limit: number;
      leaseMs: number;
      staleAfterMs: number;
      /** Only rows whose expected_consumers overlap these (rows handled inline, e.g. billing, are never swept). */
      consumers: string[];
    }): Promise<WebhookEvent[]> {
      const db = dbProvider();
      const leaseFree = or(isNull(webhookEvents.enqueueLeaseUntil), lte(webhookEvents.enqueueLeaseUntil, sql`now()`));
      const consumers = sql.join(opts.consumers.map((c) => sql`${c}`), sql`, `);
      const stranded = and(
        sql`${webhookEvents.expectedConsumers} && ARRAY[${consumers}]::text[]`,
        leaseFree,
        or(
          isNull(webhookEvents.enqueuedAt),
          and(
            eq(webhookEvents.status, 'received'),
            lte(webhookEvents.enqueuedAt, sql`now() - make_interval(secs => ${Math.max(0, opts.staleAfterMs) / 1000}::double precision)`),
          ),
        ),
      );
      const candidates = db
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(stranded)
        .orderBy(asc(webhookEvents.receivedAt))
        .limit(opts.limit)
        .for('update', { skipLocked: true });
      return db
        .update(webhookEvents)
        .set({ enqueueLeaseUntil: nowPlus(opts.leaseMs), updatedAt: sql`now()` })
        .where(and(inLockedCandidates(webhookEvents.id, candidates), stranded))
        .returning();
    },

    /**
     * Claim the right to run `consumer` for this event — ONE statement:
     *
     *   INSERT INTO webhook_event_consumers (...) VALUES (..., 'processing', ...)
     *   ON CONFLICT (webhook_event_id, consumer) DO UPDATE
     *     SET status = 'processing', attempts = attempts + 1, claim_token = <new>, ...
     *     WHERE status = 'failed' OR (status = 'processing' AND lease_expires_at <= now())
     *   RETURNING *
     *
     * - no row yet → inserted → claimed
     * - previous attempt failed, or its owner died and the lease lapsed →
     *   re-claimed in place (this is the clean-retry path B5 lacked)
     * - `processed` → nothing returned → a genuine replay
     * - `processing` under a live lease → nothing returned → another worker
     *   is on it right now
     */
    async claimConsumer(webhookEventId: string, consumer: string, leaseMs: number): Promise<WebhookConsumerClaimResult> {
      const db = dbProvider();
      const rows = await db
        .insert(webhookEventConsumers)
        .values({
          webhookEventId,
          consumer,
          status: 'processing',
          attempts: 1,
          leaseExpiresAt: nowPlus(leaseMs),
        })
        .onConflictDoUpdate({
          target: [webhookEventConsumers.webhookEventId, webhookEventConsumers.consumer],
          set: {
            status: 'processing',
            attempts: sql`${webhookEventConsumers.attempts} + 1`,
            claimToken: sql`gen_random_uuid()`,
            leaseExpiresAt: sql`excluded.lease_expires_at`,
            lastError: sql`NULL`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${webhookEventConsumers.status} = 'failed' OR (${webhookEventConsumers.status} = 'processing' AND ${webhookEventConsumers.leaseExpiresAt} <= now())`,
        })
        .returning();

      if (rows[0]) {
        // Row-level summary only; the consumer row above is authoritative.
        await db
          .update(webhookEvents)
          .set({ status: 'processing', attempts: sql`${webhookEvents.attempts} + 1`, updatedAt: sql`now()` })
          .where(and(eq(webhookEvents.id, webhookEventId), ne(webhookEvents.status, 'processed')));
        return { claimed: true, consumer: rows[0] };
      }
      const existing = await repo.findConsumer(webhookEventId, consumer);
      return { claimed: false, existing };
    },

    async findConsumer(webhookEventId: string, consumer: string): Promise<WebhookEventConsumer | undefined> {
      const db = dbProvider();
      const rows = await db
        .select()
        .from(webhookEventConsumers)
        .where(and(eq(webhookEventConsumers.webhookEventId, webhookEventId), eq(webhookEventConsumers.consumer, consumer)))
        .limit(1);
      return rows[0];
    },

    async findConsumers(webhookEventId: string): Promise<WebhookEventConsumer[]> {
      const db = dbProvider();
      return db
        .select()
        .from(webhookEventConsumers)
        .where(eq(webhookEventConsumers.webhookEventId, webhookEventId))
        .orderBy(asc(webhookEventConsumers.consumer));
    },

    /**
     * Mark this consumer done. Fenced by `claimToken`: returns false (and
     * changes nothing) if the claim was lost to another worker after a lease
     * lapse. When every expected consumer is processed, the event row flips
     * to `processed`.
     */
    async completeConsumer(webhookEventId: string, consumer: string, claimToken: string): Promise<boolean> {
      const db = dbProvider();
      const rows = await db
        .update(webhookEventConsumers)
        .set({ status: 'processed', processedAt: sql`now()`, leaseExpiresAt: null, lastError: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(webhookEventConsumers.webhookEventId, webhookEventId),
            eq(webhookEventConsumers.consumer, consumer),
            eq(webhookEventConsumers.claimToken, claimToken),
            eq(webhookEventConsumers.status, 'processing'),
          ),
        )
        .returning({ id: webhookEventConsumers.webhookEventId });
      if (rows.length === 0) return false;

      // Each consumer commits its own row BEFORE running this check, so the
      // later of two concurrently-finishing consumers always sees both.
      await db
        .update(webhookEvents)
        .set({ status: 'processed', processedAt: sql`now()`, lastError: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(webhookEvents.id, webhookEventId),
            ne(webhookEvents.status, 'processed'),
            sql`NOT EXISTS (
              SELECT 1 FROM unnest(webhook_events.expected_consumers) AS ec(name)
              WHERE NOT EXISTS (
                SELECT 1 FROM webhook_event_consumers wc
                WHERE wc.webhook_event_id = webhook_events.id
                  AND wc.consumer = ec.name
                  AND wc.status = 'processed'
              )
            )`,
          ),
        );
      return true;
    },

    /** Record a failed attempt (retryable: claimConsumer can re-claim a `failed` row). Same fencing as completeConsumer. */
    async failConsumer(webhookEventId: string, consumer: string, claimToken: string, error: string): Promise<boolean> {
      const db = dbProvider();
      const message = error.slice(0, 2000);
      const rows = await db
        .update(webhookEventConsumers)
        .set({ status: 'failed', leaseExpiresAt: null, lastError: message, updatedAt: sql`now()` })
        .where(
          and(
            eq(webhookEventConsumers.webhookEventId, webhookEventId),
            eq(webhookEventConsumers.consumer, consumer),
            eq(webhookEventConsumers.claimToken, claimToken),
            eq(webhookEventConsumers.status, 'processing'),
          ),
        )
        .returning({ id: webhookEventConsumers.webhookEventId });
      if (rows.length === 0) return false;
      await db
        .update(webhookEvents)
        .set({ status: 'failed', lastError: `${consumer}: ${message}`, updatedAt: sql`now()` })
        .where(and(eq(webhookEvents.id, webhookEventId), ne(webhookEvents.status, 'processed')));
      return true;
    },

    /**
     * Write a webhook consumer's durable side effects — an `events` row and,
     * optionally, its `outbox_events` row — AT MOST ONCE per
     * `idempotencyKey`, in ONE statement:
     *
     *   WITH prior AS (SELECT id FROM events WHERE idempotency_key = $k LIMIT 1),
     *        ins_event AS (INSERT INTO events (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM prior) RETURNING id),
     *        ins_outbox AS (INSERT INTO outbox_events (...) SELECT ... FROM ins_event RETURNING id)
     *   SELECT ...
     *
     * - Both rows commit together or not at all (one statement = one
     *   implicit transaction). This replaces the payment consumer's old
     *   runInTransaction() wrapper, which could never work on the production
     *   neon-http driver (gap register D1) and never passed its `tx` to the
     *   two writes anyway (D2).
     * - A retry after a failure LATER in the job (e.g. the EventBus emit)
     *   finds `prior` and writes nothing, so the job can be retried safely
     *   instead of being replay-locked (B5) or double-recording.
     * Only one worker at a time holds a consumer claim (lease-fenced), which
     * is what makes the NOT EXISTS guard sufficient without a unique index.
     *
     * Phase 5: optionally also applies the BUSINESS-STATE change the event
     * implies — a `transactions` status transition — in the SAME statement:
     *
     *   , target_tx AS (SELECT id FROM transactions
     *                     WHERE provider_transaction_id = $ptx ORDER BY created_at LIMIT 1)
     *   , upd_tx AS (UPDATE transactions t SET status = $to, updated_at = now()
     *                  FROM target_tx
     *                 WHERE t.id = target_tx.id AND t.status IN ($allowedFrom...)
     *                   AND EXISTS (SELECT 1 FROM ins_event)
     *                 RETURNING t.id)
     *
     * so the event record, its outbox row and the state change commit
     * together or not at all, at most once per idempotencyKey. (Before, the
     * payment consumer ran this update as a separate best-effort statement
     * AFTER the events/outbox write and swallowed its errors — a failure
     * there was silently lost while the outbox announced the event.) The
     * lookup and the transition guard are evaluated by Postgres inside the
     * statement, on the row's current status, so there is no separate read
     * to race the way transactionRepository.updateStatus's read-then-write
     * can (D11). A
     * transition the guard refuses is not an error: `transactionUpdated`
     * reports false.
     */
    async persistEffectsOnce(input: {
      idempotencyKey: string;
      event: {
        appId: string;
        tenantId?: string | null;
        category: string;
        providerId: string | null;
        status: string;
        decisionReason: string | null;
        payload: unknown;
        response?: unknown;
      };
      outbox?: { appId: string; eventType: string; payload: unknown };
      /**
       * Matched like transactionRepository.findByProviderTransactionId
       * (oldest row with this provider transaction id). Phase 6 (D4): when no
       * row carries that provider id yet, falls back to the platform's own
       * row id the platform attached to the charge (e.g. Stripe
       * `metadata.bisPaymentTransactionId`) — ONLY for a row that has no
       * provider id yet and belongs to the same provider (or was never
       * assigned one) — so an ambiguous ('unknown', provider id never
       * received) row can be resolved by the provider's own later webhook.
       * Such a match also fills in the row's provider_transaction_id.
       */
      transactionStatus?: {
        providerTransactionId: string;
        toStatus: string;
        allowedFrom: readonly string[];
        paymentTransactionId?: string | null;
      };
    }): Promise<{ inserted: boolean; eventId: string | null; transactionUpdated: boolean }> {
      const db = dbProvider();
      const e = input.event;
      const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
      const outboxCte = input.outbox
        ? sql`, ins_outbox AS (
            INSERT INTO outbox_events (app_id, event_type, payload)
            SELECT ${input.outbox.appId}, ${input.outbox.eventType}, ${json(input.outbox.payload)}::jsonb FROM ins_event
            RETURNING id
          )`
        : sql``;
      const ts = input.transactionStatus;
      const bisTxId = ts?.paymentTransactionId && UUID_RE.test(ts.paymentTransactionId) ? ts.paymentTransactionId : null;
      const byPlatformId = bisTxId
        ? sql` UNION ALL
            SELECT id, created_at, 1 AS pri FROM transactions
            WHERE id = ${bisTxId}::uuid AND provider_transaction_id IS NULL
              AND provider_id IN (${e.providerId ?? ''}, 'unassigned')`
        : sql``;
      const leavingAmbiguous = sql`t.status IN ('unknown', 'requires_reconciliation')`;
      const resolutionJson = JSON.stringify({ source: 'provider_webhook', webhookIdempotencyKey: input.idempotencyKey, providerTransactionId: ts?.providerTransactionId ?? null });
      const toAmbiguous = ts ? ts.toStatus === 'unknown' || ts.toStatus === 'requires_reconciliation' : false;
      // Phase 6: the same bookkeeping transactionRepository.transitionStatus
      // applies (SET-list column references read the PRE-update row).
      const ambiguitySet = toAmbiguous
        ? sql`, outcome_unknown_at = COALESCE(t.outcome_unknown_at, now())`
        : sql`, reconciliation_resolved_at = CASE WHEN ${leavingAmbiguous} THEN now() ELSE t.reconciliation_resolved_at END,
               reconciliation_resolution = CASE WHEN ${leavingAmbiguous} THEN ${resolutionJson}::jsonb ELSE t.reconciliation_resolution END`;
      const txCte =
        ts && ts.allowedFrom.length > 0
          ? sql`, target_tx AS (
            SELECT id FROM (
              SELECT id, created_at, 0 AS pri FROM transactions WHERE provider_transaction_id = ${ts.providerTransactionId}${byPlatformId}
            ) candidates
            ORDER BY pri ASC, created_at ASC, id ASC LIMIT 1
          ), upd_tx AS (
            UPDATE transactions t SET status = ${ts.toStatus}, updated_at = now(),
              provider_transaction_id = COALESCE(t.provider_transaction_id, ${ts.providerTransactionId})${ambiguitySet}
            FROM target_tx
            WHERE t.id = target_tx.id
              AND t.status IN (${sql.join(ts.allowedFrom.map((f) => sql`${f}`), sql`, `)})
              AND EXISTS (SELECT 1 FROM ins_event)
            RETURNING t.id
          )`
          : sql``;
      const txSelect = ts && ts.allowedFrom.length > 0 ? sql`(SELECT id FROM upd_tx)` : sql`NULL::uuid`;
      const result = await db.execute(sql`
        WITH prior AS (
          SELECT id FROM events WHERE idempotency_key = ${input.idempotencyKey} LIMIT 1
        ), ins_event AS (
          INSERT INTO events (app_id, tenant_id, category, provider_id, status, decision_reason, payload, response, idempotency_key)
          SELECT ${e.appId}, COALESCE(${e.tenantId ?? null}::text, 'default'), ${e.category}, ${e.providerId}, ${e.status},
                 ${e.decisionReason}, ${json(e.payload)}::jsonb, ${json(e.response)}::jsonb, ${input.idempotencyKey}
          WHERE NOT EXISTS (SELECT 1 FROM prior)
          RETURNING id
        )${outboxCte}${txCte}
        SELECT (SELECT id FROM ins_event) AS inserted_id, (SELECT id FROM prior) AS prior_id, ${txSelect} AS tx_updated_id
      `);
      // neon-http returns { rows }, postgres-js returns the rows array itself.
      const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{
        inserted_id: string | null;
        prior_id: string | null;
        tx_updated_id: string | null;
      }>;
      const row = rows[0];
      // Phase 5: COMMIT CONFIRMATION. The statement runs in an implicit
      // transaction that commits only when the server processes Sync —
      // AFTER it has already streamed the RETURNING rows. A driver may hand
      // those rows back as success before it sees a commit-time
      // ErrorResponse: postgres-js 3.4.7 does exactly that (it resolves on
      // CommandComplete; a later error from the implicit COMMIT, e.g. a
      // deferred constraint, is dropped), proven in
      // outbox.postgres.integration.test.ts. Trusting such a result would
      // make the consumer mark the webhook processed while its events row,
      // outbox row and transaction status change were all rolled back —
      // silent loss. The production neon-http path cannot be checked from
      // the test sandbox, so the guarantee is not left to the driver: one
      // primary-key read confirms the events row is durably visible (the
      // three writes share one statement, so they committed together or
      // not at all), and anything else fails the call so the job retries.
      if (row?.inserted_id) {
        const check = await db.execute(sql`SELECT 1 AS ok FROM events WHERE id = ${row.inserted_id}`);
        const confirmed = (Array.isArray(check) ? check : (check as { rows?: unknown[] }).rows ?? []).length > 0;
        if (!confirmed) {
          throw new Error(
            `persistEffectsOnce: write for idempotency key ${input.idempotencyKey} was reported but is not committed (commit-time failure) — nothing persisted, retry`,
          );
        }
      }
      return {
        inserted: Boolean(row?.inserted_id),
        eventId: row?.inserted_id ?? row?.prior_id ?? null,
        transactionUpdated: Boolean(row?.tx_updated_id),
      };
    },

    async count(): Promise<number> {
      const db = dbProvider();
      const rows = await db.select({ value: sql<number>`count(*)::int` }).from(webhookEvents);
      return Number(rows[0]?.value ?? 0);
    },
  };
  return repo;
}

export type WebhookEventRepository = ReturnType<typeof createWebhookEventRepository>;

export const webhookEventRepository: WebhookEventRepository = createWebhookEventRepository(
  () => getDb() as unknown as AnyPgDb,
);
