import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type postgres from 'postgres';

/**
 * Phase 16 — database integrity audit (gap register D14, D15, D16) against a
 * REAL PostgreSQL migrated from zero with this package's real migrations:
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/database-integrity.postgres.integration.test.ts
 *
 *  - D15 drift guard: the migrated catalog (tables, columns, primary keys,
 *    indexes, foreign keys incl. ON DELETE, unique constraints, CHECKs) must
 *    equal src/schema as drizzle-kit itself serialises it. This is the check
 *    the missing 0002-0010 snapshots and `drizzle-kit check` never gave: it
 *    is how idx_suppliers_application_slug (declared, recorded in every
 *    snapshot since 0011, never created) was found.
 *  - D16: provider_health pruning; audit attribution survives app deletion
 *    attempts; supplier slugs unique.
 *  - D14: no silent 'default' tenant; blank tenant ids rejected.
 *  - Migration 0021 on a database already at 0020 with legacy data.
 *
 * Skipped when TEST_POSTGRES_URL is unset; the in-memory half is
 * schema-integrity.test.ts + repositories/provider-health.test.ts.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;

const pg = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('./connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('not available');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy' }),
}));

import {
  createMigratedTestDatabase,
  createPartiallyMigratedTestDatabase,
  type MigratedTestDatabase,
} from './test-utils/postgres-test-db';
import { providerHealthRepository } from './repositories/provider-health';
import { expectedFingerprint, actualFingerprint, diff } from './test-utils/schema-fingerprint';

type Sql = ReturnType<typeof postgres>;

const TENANT_CHECK_TABLES = [
  'checkout_sessions', 'consent_records', 'conversations', 'events', 'idempotency_records',
  'keyword_command_dispatches', 'keyword_commands', 'messaging_profiles', 'suppliers',
  'transactions', 'webhook_endpoints', 'webhook_events',
];

async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string; message?: string } | null> {
  return p.then(() => null, (e) => e);
}

describe.skipIf(!ADMIN_URL)('Phase 16 — database integrity (real PostgreSQL)', () => {
  let main: MigratedTestDatabase;
  let sql: Sql;

  beforeAll(async () => {
    main = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p16');
    sql = main.client;
    pg.db = main.db;
  }, 60_000);

  afterAll(async () => {
    await main?.drop();
  });

  describe('D15 — the migrated schema IS the declared schema', () => {
    it('a database migrated from zero matches src/schema: tables, columns, PKs, indexes, FKs (with ON DELETE), unique and CHECK constraints', async () => {
      const result = diff(expectedFingerprint(), await actualFingerprint(sql));
      expect(result).toEqual({ declaredButMissingFromMigratedDb: [], inMigratedDbButNotDeclared: [] });
    });

    it('every CHECK constraint in a freshly migrated database is VALIDATED (not merely NOT VALID)', async () => {
      const notValid = await sql`SELECT conrelid::regclass::text AS t, conname FROM pg_constraint
        WHERE contype = 'c' AND NOT convalidated AND connamespace = 'public'::regnamespace`;
      expect(notValid).toEqual([]);
    });

    it('supplier slugs are unique per (application, tenant): a duplicate is rejected by idx_suppliers_application_slug', async () => {
      const [app] = await sql`INSERT INTO applications (name, slug) VALUES ('P16 Slug App', 'p16-slug-app') RETURNING id`;
      await sql`INSERT INTO suppliers (application_id, tenant_id, name, slug, type) VALUES (${app.id}, 't1', 'Hotel A', 'hotel-a', 'hotel')`;
      // Same slug under another tenant of the same application is fine.
      await sql`INSERT INTO suppliers (application_id, tenant_id, name, slug, type) VALUES (${app.id}, 't2', 'Hotel A', 'hotel-a', 'hotel')`;
      const err = await pgError(sql`INSERT INTO suppliers (application_id, tenant_id, name, slug, type) VALUES (${app.id}, 't1', 'Hotel A again', 'hotel-a', 'hotel')`);
      expect(err?.code).toBe('23505');
      expect(err?.constraint_name).toBe('idx_suppliers_application_slug');
    });
  });

  describe('D16 — provider_health pruning', () => {
    it('pruneOlderThan(30) deletes exactly the rows checked before the cutoff and keeps the recent ones', async () => {
      const [p] = await sql`INSERT INTO providers (slug, name, category) VALUES ('p16-prune', 'P16 Prune', 'messaging') RETURNING id`;
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      for (const d of [400, 90, 31]) {
        await sql`INSERT INTO provider_health (provider_id, check_type, status, checked_at) VALUES (${p.id}, 'liveness', 'healthy', ${ago(d)}::timestamptz)`;
      }
      for (const d of [29, 1, 0]) {
        await sql`INSERT INTO provider_health (provider_id, check_type, status, checked_at) VALUES (${p.id}, 'liveness', 'healthy', ${ago(d)}::timestamptz)`;
      }

      expect(await providerHealthRepository.pruneOlderThan(30)).toBe(3);

      const left = await sql<{ age: number }[]>`
        SELECT floor(extract(epoch FROM now() - checked_at) / 86400)::int AS age
        FROM provider_health WHERE provider_id = ${p.id} ORDER BY checked_at`;
      expect(left.map((r) => r.age)).toEqual([29, 1, 0]);
      // Idempotent: nothing older is left to prune.
      expect(await providerHealthRepository.pruneOlderThan(30)).toBe(0);
    });
  });

  describe('D16 — audit_logs attribution', () => {
    it('an application with audit history cannot be hard-deleted (its audit rows keep their attribution)', async () => {
      const [app] = await sql`INSERT INTO applications (name, slug) VALUES ('P16 Audit App', 'p16-audit-app') RETURNING id`;
      const [log] = await sql`INSERT INTO audit_logs (application_id, action, resource) VALUES (${app.id}, 'key.rotated', 'api_key') RETURNING id`;
      const err = await pgError(sql`DELETE FROM applications WHERE id = ${app.id}`);
      expect(err?.code).toBe('23503');
      expect(err?.constraint_name).toBe('audit_logs_application_id_applications_id_fk');
      const [row] = await sql`SELECT application_id FROM audit_logs WHERE id = ${log.id}`;
      expect(row.application_id).toBe(app.id);
    });

    it('an application with no audit history (and no events) can still be deleted — RESTRICT blocks only attribution loss', async () => {
      const [app] = await sql`INSERT INTO applications (name, slug) VALUES ('P16 Bare App', 'p16-bare-app') RETURNING id`;
      await sql`DELETE FROM applications WHERE id = ${app.id}`;
      expect(await sql`SELECT 1 FROM applications WHERE id = ${app.id}`).toHaveLength(0);
    });
  });

  describe('D14 — tenant identifiers', () => {
    it("omitting the tenant is a NOT NULL violation — never a silent 'default' tenant", async () => {
      const attempts: Array<[string, Promise<unknown>]> = [
        ['transactions', sql`INSERT INTO transactions (app_id, provider_id, amount, currency) VALUES ('p16', 'stripe', 10, 'USD')`],
        ['conversations', sql`INSERT INTO conversations (phone_number, app_id, provider_id, channel) VALUES ('+15550160001', 'p16', 'twilio', 'sms')`],
        ['consent_records', sql`INSERT INTO consent_records (app_id, recipient, channel, status, source) VALUES ('p16', '+15550160001', 'sms', 'opted_out', 'api')`],
      ];
      for (const [table, attempt] of attempts) {
        const err = await pgError(attempt);
        expect(err?.code, table).toBe('23502');
      }
      const defaults = await sql`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND column_default IS NOT NULL ORDER BY table_name`;
      expect(defaults.map((r) => r.table_name)).toEqual(['events']);
    });

    it('a blank or whitespace-only tenant id is rejected by every free-text tenant table', async () => {
      const blank = [
        sql`INSERT INTO transactions (app_id, tenant_id, provider_id, amount, currency) VALUES ('p16', '', 'stripe', 10, 'USD')`,
        sql`INSERT INTO conversations (phone_number, app_id, tenant_id, provider_id, channel) VALUES ('+15550160002', 'p16', '   ', 'twilio', 'sms')`,
        sql`INSERT INTO consent_records (app_id, tenant_id, recipient, channel, status, source) VALUES ('p16', '', '+15550160002', 'sms', 'opted_out', 'api')`,
        sql`INSERT INTO events (app_id, tenant_id, category, status) VALUES ('system', ' ', 'other', 'success')`,
      ];
      for (const attempt of blank) {
        const err = await pgError(attempt);
        expect(err?.code).toBe('23514');
        expect(err?.constraint_name).toMatch(/^chk_[a-z_]+_tenant_id_nonblank$/);
      }
      // NULL stays legal where the column is nullable (platform-level event).
      await sql`INSERT INTO events (app_id, tenant_id, category, status) VALUES ('system', NULL, 'other', 'success')`;
      const checks = await sql`SELECT conrelid::regclass::text AS t FROM pg_constraint
        WHERE contype = 'c' AND conname LIKE 'chk\\_%\\_tenant\\_id\\_nonblank' AND convalidated ORDER BY 1`;
      expect(checks.map((r) => r.t)).toEqual([...TENANT_CHECK_TABLES].sort());
    });
  });

  describe('migration 0021 on a database already at 0020', () => {
    it('upgrades with legacy data: nothing deleted, blank-tenant table left NOT VALID (others validated), FK renamed, keys in force', async () => {
      const db = await createPartiallyMigratedTestDatabase(ADMIN_URL!, 20, 'bis_p16_up');
      try {
        const c = db.client;
        const [app] = await c`INSERT INTO applications (name, slug) VALUES ('Legacy', 'legacy') RETURNING id`;
        await c`INSERT INTO suppliers (application_id, tenant_id, name, slug, type) VALUES (${app.id}, 't1', 'Hotel', 'hotel', 'hotel')`;
        await c`INSERT INTO audit_logs (application_id, action, resource) VALUES (${app.id}, 'x', 'y')`;
        // Storable before 0021: a blank tenant and an omitted tenant ('default').
        await c`INSERT INTO conversations (phone_number, app_id, tenant_id, provider_id, channel) VALUES ('+15550160003', 'legacy', '', 'twilio', 'sms')`;
        await c`INSERT INTO conversations (phone_number, app_id, provider_id, channel) VALUES ('+15550160004', 'legacy', 'twilio', 'sms')`;
        const [{ fk_before }] = await c`SELECT count(*)::int AS fk_before FROM pg_constraint WHERE conname = 'suppliers_application_id_fkey'`;
        expect(fk_before).toBe(1);

        await db.migrateRest();

        expect(await c`SELECT tenant_id FROM conversations ORDER BY phone_number`).toEqual([{ tenant_id: '' }, { tenant_id: 'default' }]);
        const notValid = await c`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'c' AND NOT convalidated`;
        expect(notValid.map((r) => r.t)).toEqual(['conversations']);
        // ...but still enforced for new rows.
        const err = await pgError(c`INSERT INTO conversations (phone_number, app_id, tenant_id, provider_id, channel) VALUES ('+15550160005', 'legacy', '', 'twilio', 'sms')`);
        expect(err?.code).toBe('23514');

        const fks = await c`SELECT conname FROM pg_constraint WHERE conrelid = 'suppliers'::regclass AND contype = 'f'`;
        expect(fks.map((r) => r.conname)).toEqual(['suppliers_application_id_applications_id_fk']);
        const [{ def }] = await c`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'uq_conversations_owner'`;
        expect(def).toBe('UNIQUE NULLS NOT DISTINCT (phone_number, business_number, app_id, tenant_id, supplier_id, channel)');
        const [{ del }] = await c`SELECT confdeltype AS del FROM pg_constraint WHERE conname = 'audit_logs_application_id_applications_id_fk'`;
        expect(del).toBe('r');
        expect(await c`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_suppliers_application_slug'`).toHaveLength(1);
      } finally {
        await db.drop();
      }
    });

    it('refuses to upgrade over duplicate supplier slugs with an actionable error (never auto-deletes), and succeeds once they are reconciled', async () => {
      const db = await createPartiallyMigratedTestDatabase(ADMIN_URL!, 20, 'bis_p16_dup');
      try {
        const c = db.client;
        const [app] = await c`INSERT INTO applications (name, slug) VALUES ('Dup', 'dup') RETURNING id`;
        await c`INSERT INTO suppliers (application_id, tenant_id, name, slug, type) VALUES (${app.id}, 't1', 'A', 'same', 'hotel'), (${app.id}, 't1', 'B', 'same', 'hotel')`;

        const err = await pgError(db.migrateRest());
        // drizzle's migrator wraps the PostgresError; the RAISE text is its cause.
        expect(String((err as any)?.cause?.message ?? err?.message)).toContain('migration 0021: 1 (application_id, tenant_id, slug) group(s) in "suppliers" have duplicate rows');
        expect(await c`SELECT 1 FROM suppliers`).toHaveLength(2);
        expect(await c`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_suppliers_application_slug'`).toHaveLength(0);

        await c`UPDATE suppliers SET slug = 'same-2' WHERE name = 'B'`;
        await db.migrateRest();
        expect(await c`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_suppliers_application_slug'`).toHaveLength(1);
      } finally {
        await db.drop();
      }
    });
  });
});
