import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createIdempotencyRecordRepository } from './repositories/idempotency-records';
import { PlatformIdempotencyService, computeRequestHash } from '@company/shared';

/**
 * Phase 2 proof against a REAL PostgreSQL server (not Neon-HTTP, not a mock).
 *
 * Runs only when TEST_POSTGRES_URL points at a Postgres server the test may
 * create/drop databases on, e.g.
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     npx vitest run packages/database/src/idempotency.postgres.integration.test.ts
 *
 * Every database it uses is created fresh and migrated FROM ZERO with
 * drizzle-orm's own migrator over this repo's drizzle/ folder, then dropped.
 * The production repository code is used unchanged — only the drizzle handle
 * differs (postgres-js instead of neon-http; both use the same PgDialect, so
 * the SQL sent is identical).
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('Phase 2 — idempotency on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const clients: Array<ReturnType<typeof postgres>> = [];

  async function freshDb(): Promise<{ name: string; client: ReturnType<typeof postgres>; db: PostgresJsDatabase }> {
    const name = `bis_p2_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
    const client = postgres(urlFor(name), { max: 10, onnotice: () => {} });
    clients.push(client);
    return { name, client, db: drizzle(client) };
  }

  /** drizzle/ copy whose journal stops after `lastIdx` (to model an already-deployed DB). */
  function migrationsThrough(lastIdx: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bis-drizzle-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  let main: Awaited<ReturnType<typeof freshDb>>;
  let service: PlatformIdempotencyService;
  let repo: ReturnType<typeof createIdempotencyRecordRepository>;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    main = await freshDb();
    await migrate(main.db, { migrationsFolder: MIGRATIONS });
    repo = createIdempotencyRecordRepository(() => main.db as never);
    service = new PlatformIdempotencyService(repo);
  });

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  // ---------------------------------------------------------------------
  // D3 — the unique index really exists after migrating from zero
  // ---------------------------------------------------------------------
  describe('migration 0013 (from zero, real drizzle migrator)', () => {
    it('creates idx_transactions_idempotency as a UNIQUE index on (app_id, tenant_id, idempotency_key)', async () => {
      const rows = await main.client`
        SELECT i.indisunique AS unique,
               array_agg(a.attname ORDER BY k.ord) AS cols
        FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE c.relname = 'idx_transactions_idempotency'
        GROUP BY i.indisunique`;
      expect(rows).toHaveLength(1);
      expect(rows[0].unique).toBe(true);
      expect(rows[0].cols).toEqual(['app_id', 'tenant_id', 'idempotency_key']);
    });

    it('a literal duplicate keyed transaction INSERT is rejected by Postgres with 23505', async () => {
      const insert = () => main.client`
        INSERT INTO transactions (app_id, tenant_id, provider_id, amount, currency, idempotency_key)
        VALUES ('app_d3', 'ten_d3', 'stripe', 10, 'USD', 'dup-key')`;
      await insert();
      const err = await insert().then(
        () => null,
        (e: unknown) => e as { code?: string; constraint_name?: string },
      );
      expect(err?.code).toBe('23505');
      expect(err?.constraint_name).toBe('idx_transactions_idempotency');

      // The same key under a different tenant is a different payment — allowed.
      await main.client`
        INSERT INTO transactions (app_id, tenant_id, provider_id, amount, currency, idempotency_key)
        VALUES ('app_d3', 'ten_other', 'stripe', 10, 'USD', 'dup-key')`;
    });

    it('payments without a key (NULL idempotency_key) never collide', async () => {
      for (let i = 0; i < 3; i++) {
        await main.client`
          INSERT INTO transactions (app_id, tenant_id, provider_id, amount, currency, idempotency_key)
          VALUES ('app_null', 'ten_null', 'stripe', 10, 'USD', NULL)`;
      }
      const [{ n }] = await main.client`SELECT count(*)::int AS n FROM transactions WHERE app_id = 'app_null'`;
      expect(n).toBe(3);
    });

    it("adds idempotency_records.request_hash text NOT NULL DEFAULT ''", async () => {
      const rows = await main.client`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'idempotency_records' AND column_name = 'request_hash'`;
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe('text');
      expect(rows[0].is_nullable).toBe('NO');
      expect(String(rows[0].column_default)).toContain("''");
    });

    it('is applied to a database that was ALREADY migrated through 0012 (journal ordering)', async () => {
      const { client, db } = await freshDb();
      const through12 = migrationsThrough(12);
      try {
        await migrate(db, { migrationsFolder: through12 });
        const before = await client`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_transactions_idempotency'`;
        expect(before).toHaveLength(0); // the defect, reproduced on a 0012 database

        await migrate(db, { migrationsFolder: MIGRATIONS });
        const after = await client`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_transactions_idempotency'`;
        expect(after).toHaveLength(1);
        const col = await client`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'idempotency_records' AND column_name = 'request_hash'`;
        expect(col).toHaveLength(1);
      } finally {
        rmSync(through12, { recursive: true, force: true });
      }
    });

    it('refuses (with an actionable message) to build the index over pre-existing duplicate charges', async () => {
      const { client, db } = await freshDb();
      const through12 = migrationsThrough(12);
      try {
        await migrate(db, { migrationsFolder: through12 });
        await client`
          INSERT INTO transactions (app_id, tenant_id, provider_id, amount, currency, idempotency_key)
          VALUES ('a', 't', 'stripe', 10, 'USD', 'k'), ('a', 't', 'stripe', 10, 'USD', 'k')`;
        const err = await migrate(db, { migrationsFolder: MIGRATIONS }).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err).not.toBeNull();
        const message = `${err?.message ?? ''} ${String((err as { cause?: { message?: string } })?.cause?.message ?? '')}`;
        expect(message).toContain('already have duplicate rows');
        // Nothing was deleted.
        const [{ n }] = await client`SELECT count(*)::int AS n FROM transactions`;
        expect(n).toBe(2);
      } finally {
        rmSync(through12, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------
  // D8 / D9 / C2 — the claim statement's semantics on real Postgres
  // ---------------------------------------------------------------------
  describe('PlatformIdempotencyService + repository.claim (single INSERT ... ON CONFLICT DO UPDATE ... WHERE)', () => {
    const h1 = computeRequestHash({ amount: 40, currency: 'USD' });
    const h2 = computeRequestHash({ amount: 4000, currency: 'USD' });
    let n = 0;
    const key = () => `key-${++n}-${randomBytes(3).toString('hex')}`;

    it('1. 20 truly concurrent claims of one key: exactly one wins, the rest see in_progress', async () => {
      const k = key();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.checkAndClaim('app', 'ten', 'payment', k, h1)),
      );
      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'in_progress')).toHaveLength(19);
      const [{ c }] = await main.client`SELECT count(*)::int AS c FROM idempotency_records WHERE idempotency_key = ${k}`;
      expect(c).toBe(1);
    });

    it('1b. concurrent duplicates that wait get the SAME stored result as the winner', async () => {
      const k = key();
      const winner = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      expect(winner.outcome).toBe('claimed');
      const waiters = Array.from({ length: 5 }, () =>
        service.checkAndClaim('app', 'ten', 'payment', k, h1, { waitForInFlightMs: 5_000, pollIntervalMs: 25 }),
      );
      setTimeout(() => {
        void service.complete(winner.recordId!, { event: { id: 'ch_same' } });
      }, 200);
      const results = await Promise.all(waiters);
      for (const r of results) {
        expect(r.outcome).toBe('replay');
        expect(r.existingResult).toEqual({ event: { id: 'ch_same' } });
      }
    });

    it('2. a different request hash under the same key is a conflict — while processing and after completion', async () => {
      const k = key();
      const first = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      expect(first.outcome).toBe('claimed');
      expect((await service.checkAndClaim('app', 'ten', 'payment', k, h2)).outcome).toBe('conflict');
      await service.complete(first.recordId!, { event: { id: 'ch_1' } });
      const after = await service.checkAndClaim('app', 'ten', 'payment', k, h2);
      expect(after.outcome).toBe('conflict');
      expect(after.existingResult).toEqual({ event: { id: 'ch_1' } });
      const [row] = await main.client`SELECT request_hash, status FROM idempotency_records WHERE idempotency_key = ${k}`;
      expect(row.request_hash).toBe(h1);
      expect(row.status).toBe('completed');
    });

    it('3. reuse after expiry: re-claimed in place by the upsert (no 23505), id rotated, stale owner fenced out', async () => {
      const k = key();
      const first = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      await main.client`UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE idempotency_key = ${k}`;

      // Old code path, for contrast: a plain INSERT of the same key still violates the unique index.
      const plain = await repo
        .create({ appId: 'app', tenantId: 'ten', operation: 'payment', idempotencyKey: k, status: 'processing', expiresAt: new Date() })
        .then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
      expect(plain?.code ?? plain?.cause?.code).toBe('23505');

      const again = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      expect(again.outcome).toBe('claimed');
      expect(again.recordId).not.toBe(first.recordId);
      const rows = await main.client`SELECT id, status, expires_at > now() AS live FROM idempotency_records WHERE idempotency_key = ${k}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('processing');
      expect(rows[0].live).toBe(true);

      // The request that held the expired claim can no longer overwrite the new owner's record.
      expect(await service.complete(first.recordId!, { event: { id: 'stale' } })).toBe(false);
      expect(await service.complete(again.recordId!, { event: { id: 'fresh' } })).toBe(true);
      const [final] = await main.client`SELECT result FROM idempotency_records WHERE idempotency_key = ${k}`;
      expect(final.result).toEqual({ event: { id: 'fresh' } });
    });

    it('3b. 20 concurrent re-claims of one expired row: exactly one wins', async () => {
      const k = key();
      await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      await main.client`UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE idempotency_key = ${k}`;
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.checkAndClaim('app', 'ten', 'payment', k, h1)),
      );
      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    });

    it("4. reuse after 'failed': same request re-claims cleanly; a different request is a conflict", async () => {
      const k = key();
      const first = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      expect(await service.fail(first.recordId!, 'provider down')).toBe(true);

      expect((await service.checkAndClaim('app', 'ten', 'payment', k, h2)).outcome).toBe('conflict');
      const retry = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      expect(retry.outcome).toBe('claimed');
      const rows = await main.client`SELECT status FROM idempotency_records WHERE idempotency_key = ${k}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('processing');
    });

    it("legacy rows (request_hash = '') stay usable: a failed legacy row is re-claimable", async () => {
      const k = key();
      await main.client`
        INSERT INTO idempotency_records (app_id, tenant_id, operation, idempotency_key, status, expires_at)
        VALUES ('app', 'ten', 'payment', ${k}, 'failed', now() + interval '5 minutes')`;
      const r = await service.checkAndClaim('app', 'ten', 'payment', k, h1);
      expect(r.outcome).toBe('claimed');
      const [row] = await main.client`SELECT request_hash FROM idempotency_records WHERE idempotency_key = ${k}`;
      expect(row.request_hash).toBe(h1);
    });

    it('scope: the same key under another app, tenant or operation is independent', async () => {
      const k = key();
      expect((await service.checkAndClaim('app', 'ten', 'payment', k, h1)).outcome).toBe('claimed');
      expect((await service.checkAndClaim('app2', 'ten', 'payment', k, h1)).outcome).toBe('claimed');
      expect((await service.checkAndClaim('app', 'ten2', 'payment', k, h1)).outcome).toBe('claimed');
      expect((await service.checkAndClaim('app', 'ten', 'refund', k, h1)).outcome).toBe('claimed');
    });
  });
});
