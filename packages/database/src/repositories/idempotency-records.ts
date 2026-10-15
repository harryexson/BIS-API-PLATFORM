import { eq, and, gt, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { getDb } from '../connection';
import { idempotencyRecords, type IdempotencyRecord } from '../schema';

// Any drizzle Postgres database handle: the production neon-http one, or the
// postgres-js one the real-Postgres integration test binds to. The query
// builder emits identical SQL for both (same PgDialect).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

export interface IdempotencyClaimInput {
  appId: string;
  tenantId: string;
  operation: string;
  idempotencyKey: string;
  /** SHA-256 hex of the canonicalised mutating request fields. */
  requestHash: string;
  /** Lifetime of the claim, measured on the DATABASE clock. */
  ttlMs: number;
}

export type IdempotencyClaimResult =
  /** This caller now owns the key (fresh insert, or atomic re-claim of an expired/failed row). */
  | { claimed: true; record: IdempotencyRecord }
  /** Someone else owns the key; `existing` is the row as read immediately afterwards. */
  | { claimed: false; existing: IdempotencyRecord | undefined };

/**
 * Factory so the exact same SQL can be exercised against a real Postgres in
 * tests (the production driver, neon-http, can only talk to Neon's HTTP
 * endpoint). Production code uses the `idempotencyRecordRepository`
 * singleton below, bound to `getDb()`.
 */
export function createIdempotencyRecordRepository(dbProvider: () => AnyPgDb) {
  const repo = {
    async findActive(
      appId: string,
      tenantId: string,
      operation: string,
      idempotencyKey: string,
    ): Promise<IdempotencyRecord | undefined> {
      const db = dbProvider();
      const rows = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.appId, appId),
            eq(idempotencyRecords.tenantId, tenantId),
            eq(idempotencyRecords.operation, operation),
            eq(idempotencyRecords.idempotencyKey, idempotencyKey),
            gt(idempotencyRecords.expiresAt, new Date()),
          ),
        )
        .limit(1);
      return rows[0];
    },

    /** Row for the composite key regardless of status/expiry. */
    async findByKey(
      appId: string,
      tenantId: string,
      operation: string,
      idempotencyKey: string,
    ): Promise<IdempotencyRecord | undefined> {
      const db = dbProvider();
      const rows = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.appId, appId),
            eq(idempotencyRecords.tenantId, tenantId),
            eq(idempotencyRecords.operation, operation),
            eq(idempotencyRecords.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      return rows[0];
    },

    /**
     * Atomically claim an idempotency key — ONE SQL statement, no
     * transaction needed (neon-http cannot run `db.transaction()` at all):
     *
     *   INSERT INTO idempotency_records (...) VALUES (..., 'processing', ...)
     *   ON CONFLICT (app_id, tenant_id, operation, idempotency_key) DO UPDATE
     *     SET id = gen_random_uuid(), status = 'processing', request_hash = excluded.request_hash,
     *         result = NULL, created_at = now(), expires_at = excluded.expires_at
     *     WHERE idempotency_records.expires_at <= now()
     *        OR (idempotency_records.status = 'failed'
     *            AND (idempotency_records.request_hash = ''
     *                 OR idempotency_records.request_hash = excluded.request_hash))
     *   RETURNING *
     *
     * - No existing row → insert → RETURNING yields it → claimed.
     * - Existing row that is expired, or `failed` with the same (or legacy
     *   unknown '') request hash → updated in place → claimed. This is the
     *   re-claim path that used to be a bare INSERT and threw 23505.
     * - Any other existing row → the WHERE is false, Postgres does nothing
     *   and RETURNING yields no row → not claimed; the current row is then
     *   read so the caller can tell replay / in-progress / conflict apart.
     *   Two concurrent claimers are serialised by the unique index itself,
     *   so exactly one of them can ever get a row back.
     *
     * `id` is rotated on re-claim so it acts as a fencing token: a stale
     * owner of the previous claim (e.g. a request that outlived the TTL)
     * can no longer complete()/fail() the new owner's record.
     *
     * A `failed` row whose stored hash differs from the incoming one is NOT
     * re-claimable: reusing a key with a different body is rejected even
     * after a failure. An expired row is re-claimable by any body, because
     * the key's replay window has ended.
     */
    async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
      const db = dbProvider();
      const ttlSeconds = Math.max(0, input.ttlMs) / 1000;
      const rows = await db
        .insert(idempotencyRecords)
        .values({
          appId: input.appId,
          tenantId: input.tenantId,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          status: 'processing',
          expiresAt: sql`now() + make_interval(secs => ${ttlSeconds}::double precision)`,
        })
        .onConflictDoUpdate({
          target: [
            idempotencyRecords.appId,
            idempotencyRecords.tenantId,
            idempotencyRecords.operation,
            idempotencyRecords.idempotencyKey,
          ],
          set: {
            id: sql`gen_random_uuid()`,
            status: 'processing',
            requestHash: sql`excluded.request_hash`,
            result: sql`NULL`,
            createdAt: sql`now()`,
            expiresAt: sql`excluded.expires_at`,
          },
          setWhere: sql`${idempotencyRecords.expiresAt} <= now() OR (${idempotencyRecords.status} = 'failed' AND (${idempotencyRecords.requestHash} = '' OR ${idempotencyRecords.requestHash} = excluded.request_hash))`,
        })
        .returning();

      if (rows[0]) return { claimed: true, record: rows[0] };

      const existing = await repo.findByKey(input.appId, input.tenantId, input.operation, input.idempotencyKey);
      return { claimed: false, existing };
    },

    /**
     * Only the current owner (matching id, still `processing`) can complete.
     * Returns false if the claim was lost (rotated id) or already resolved.
     */
    async complete(id: string, result: unknown): Promise<boolean> {
      const db = dbProvider();
      const rows = await db
        .update(idempotencyRecords)
        .set({ status: 'completed', result })
        .where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.status, 'processing')))
        .returning({ id: idempotencyRecords.id });
      return rows.length > 0;
    },

    /** Same ownership guard as complete(). */
    async fail(id: string, error: string): Promise<boolean> {
      const db = dbProvider();
      const rows = await db
        .update(idempotencyRecords)
        .set({ status: 'failed', result: { error } })
        .where(and(eq(idempotencyRecords.id, id), eq(idempotencyRecords.status, 'processing')))
        .returning({ id: idempotencyRecords.id });
      return rows.length > 0;
    },

    /** Legacy no-hash insert. Throws 23505 if the key exists — use claim(). */
    async create(data: typeof idempotencyRecords.$inferInsert): Promise<IdempotencyRecord> {
      const db = dbProvider();
      const rows = await db.insert(idempotencyRecords).values(data).returning();
      return rows[0];
    },

    async count(): Promise<number> {
      const db = dbProvider();
      const { count } = await import('drizzle-orm');
      const rows = await db.select({ value: count() }).from(idempotencyRecords);
      return rows[0]?.value ?? 0;
    },
  };
  return repo;
}

export type IdempotencyRecordRepository = ReturnType<typeof createIdempotencyRecordRepository>;

export const idempotencyRecordRepository: IdempotencyRecordRepository = createIdempotencyRecordRepository(
  () => getDb() as unknown as AnyPgDb,
);
