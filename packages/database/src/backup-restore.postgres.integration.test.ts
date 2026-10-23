import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Phase 25 — disaster recovery: the MANUAL database backup and restore in
 * docs/operations/DISASTER_RECOVERY.md §3.1/§4.1, run for real against a
 * real PostgreSQL migrated from zero with this package's real migrations:
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/backup-restore.postgres.integration.test.ts
 *
 * BACKUP_COMMANDS / RESTORE_COMMANDS below are the runbook's commands,
 * character for character, executed by bash with the real pg_dump / psql /
 * gzip binaries (they must be on PATH; a missing binary fails the suite
 * rather than skipping it — CI's integration job is required to run it). The
 * restored database must then be indistinguishable from the source: the
 * Phase 16 drift guard's schema fingerprint, every CHECK validated, the
 * drizzle migration journal intact (so the next deploy's migrate is a
 * no-op), every row byte-identical, the integrity constraints still enforced,
 * and the AES-GCM provider secrets decryptable with — and only with — the
 * original SECRET_ENCRYPTION_KEY.
 *
 * What this cannot cover (BLOCKED — EXTERNAL VERIFICATION REQUIRED): Neon
 * point-in-time restore / branching, a live Neon connection string, and the
 * upload to off-site storage.
 *
 * Skipped when TEST_POSTGRES_URL is unset.
 */

// Must stay identical to the fenced blocks in DISASTER_RECOVERY.md §3.1 and §4.1.
const BACKUP_COMMANDS = `set -o pipefail
BACKUP="backup-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL_UNPOOLED" | gzip > "$BACKUP"`;

const RESTORE_COMMANDS = `set -o pipefail
gunzip -c "$BACKUP" | psql -v ON_ERROR_STOP=1 --single-transaction -q "$RESTORE_DATABASE_URL"`;

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

import * as schema from './schema';
import { createMigratedTestDatabase, type MigratedTestDatabase } from './test-utils/postgres-test-db';
import { expectedFingerprint, actualFingerprint, diff } from './test-utils/schema-fingerprint';
import { createProviderStateStore } from './provider-secrets';
import { ProviderSecretsDecryptError } from './provider-state-errors';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');
const KEY = 'p25-backup-restore-key-' + randomBytes(16).toString('hex');
const LEAK_SHAPED = 'provider said: invalid key sk_live_P25RESTOREFIDELITY0000';

type Sql = ReturnType<typeof postgres>;

function bash(script: string, env: Record<string, string>, cwd: string) {
  const r = spawnSync('bash', ['-c', script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string } | null> {
  return p.then(() => null, (e) => e);
}

/** Every public table's full contents, order-independently hashed. */
async function tableDigests(sql: Sql): Promise<Record<string, string>> {
  const tables = await sql<{ name: string }[]>`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const [row] = await sql.unsafe(`SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM "${name}" t`);
    out[name] = `${row.n}:${row.h}`;
  }
  return out;
}

describe.skipIf(!ADMIN_URL)('Phase 25 — manual backup (pg_dump) → restore (psql) round trip (real PostgreSQL)', () => {
  let source: MigratedTestDatabase;
  let admin: Sql;
  let restored: Sql;
  let restoreUrl: string;
  const restoreDb = `bis_p25dst_${randomBytes(6).toString('hex')}`;
  const workdir = mkdtempSync(path.join(tmpdir(), 'bis-p25-backup-'));
  const dirs = [workdir];
  let backupFile: string;
  let savedKey: string | undefined;

  beforeAll(async () => {
    for (const bin of ['pg_dump', 'psql', 'gzip', 'gunzip']) {
      const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      if (v.status !== 0) throw new Error(`${bin} is not on PATH — the backup/restore runbook cannot be verified without it`);
    }
    savedKey = process.env.SECRET_ENCRYPTION_KEY;
    process.env.SECRET_ENCRYPTION_KEY = KEY;

    source = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p25src');
    pg.db = source.db;
    const sql = source.client;
    const [t] = await sql`INSERT INTO tenants (name, slug) VALUES ('DR Tenant', 'dr-tenant') RETURNING id`;
    const [a] = await sql`INSERT INTO applications (name, slug) VALUES ('DR App', 'dr-app') RETURNING id`;
    await sql`INSERT INTO tenant_application_links (tenant_id, application_id) VALUES (${t.id}, ${a.id})`;
    await sql`INSERT INTO suppliers (application_id, tenant_id, name, slug, type) VALUES (${a.id}, ${t.id}, 'DR Supplier', 'dr-supplier', 'merchant')`;
    await sql`INSERT INTO events (app_id, tenant_id, category, status) VALUES ('dr-app', ${t.id}, 'payment', 'success')`;
    await sql`INSERT INTO audit_logs (action, resource, actor_type, actor_id, outcome) VALUES ('PATCH /api/dashboard/providers/:id', 'stripe', 'admin', 'dr-oncall', 'success')`;
    await sql`INSERT INTO outbox_events (app_id, event_type, payload, error) VALUES ('dr-app', 'payment.succeeded', '{"amount":4999}'::jsonb, ${LEAK_SHAPED})`;
    await sql`INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body, tenant_id) VALUES ('stripe', 'evt_p25', '{}'::jsonb, '{}', ${t.id})`;
    // The real Phase 15 write path (AES-256-GCM under KEY).
    const saved = await createProviderStateStore(() => source.db as never).saveSecrets({
      slug: 'stripe',
      name: 'Stripe',
      category: 'payment',
      secrets: [{ field: 'api_key', label: 'Secret key', value: 'sk_test_p25_original' }],
      expectedVersion: 0,
    });
    expect(saved).toEqual({ saved: true, version: 1 });

    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${restoreDb}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${restoreDb}`;
    restoreUrl = u.toString();
  }, 60_000);

  afterAll(async () => {
    await restored?.end({ timeout: 5 }).catch(() => undefined);
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${restoreDb} WITH (FORCE)`).catch(() => undefined);
    await admin?.end({ timeout: 5 }).catch(() => undefined);
    await source?.drop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = savedKey;
  });

  it('pg_dump can dump the server (client major version >= server major version)', async () => {
    const [{ v }] = await source.client<{ v: string }[]>`SELECT current_setting('server_version_num') AS v`;
    const serverMajor = Math.floor(Number(v) / 10000);
    const clientMajor = Number(/(\d+)\.\d+/.exec(spawnSync('pg_dump', ['--version'], { encoding: 'utf8' }).stdout)![1]);
    expect(clientMajor).toBeGreaterThanOrEqual(serverMajor);
  });

  it('the runbook backup commands succeed and write one gzip file named once (the upload uses the same name)', async () => {
    const r = bash(`${BACKUP_COMMANDS}\nprintf '%s' "$BACKUP"`, { DATABASE_URL_UNPOOLED: source.url }, workdir);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^backup-\d{8}-\d{6}\.sql\.gz$/);
    backupFile = path.join(workdir, r.stdout);
    const listing = bash(`gunzip -c "$BACKUP" | grep -c 'CREATE TABLE'`, { BACKUP: backupFile }, workdir);
    expect(Number(listing.stdout.trim())).toBeGreaterThan(30);
  });

  it('the runbook backup commands FAIL (non-zero) when pg_dump fails — a broken dump is never silently gzipped as a "successful" backup', () => {
    // Its own directory: a failed run still creates (truncates) a file with
    // the same second-resolution name, which would clobber a good backup
    // taken in the same second — the runbook says to delete it.
    const failDir = mkdtempSync(path.join(tmpdir(), 'bis-p25-backup-fail-'));
    dirs.push(failDir);
    const r = bash(BACKUP_COMMANDS, { DATABASE_URL_UNPOOLED: 'postgres://nobody@127.0.0.1:1/unreachable' }, failDir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pg_dump/);
  });

  it('the runbook restore commands load the dump into an empty database with no error', async () => {
    expect(backupFile).toBeDefined();
    const r = bash(RESTORE_COMMANDS, { BACKUP: backupFile, RESTORE_DATABASE_URL: restoreUrl }, workdir);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    restored = postgres(restoreUrl, { max: 4, onnotice: () => {} });
  });

  it('restored schema === declared schema === source schema (Phase 16 drift-guard fingerprint), every CHECK validated', async () => {
    const restoredPrint = await actualFingerprint(restored);
    expect(diff(expectedFingerprint(), restoredPrint)).toEqual({ declaredButMissingFromMigratedDb: [], inMigratedDbButNotDeclared: [] });
    expect(restoredPrint).toEqual(await actualFingerprint(source.client));
    const notValid = await restored`SELECT conrelid::regclass::text AS t, conname FROM pg_constraint
                                    WHERE connamespace = 'public'::regnamespace AND NOT convalidated`;
    expect(notValid).toEqual([]);
  });

  it('the drizzle migration journal survives, so the next deploy\'s migrate is a no-op on the restored database', async () => {
    const journal = (sql: Sql) => sql`SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
    const before = await journal(restored);
    expect(before).toEqual(await journal(source.client));
    expect(before.length).toBeGreaterThan(20);
    await migrate(drizzle(restored), { migrationsFolder: MIGRATIONS });
    expect(await journal(restored)).toEqual(before);
    expect(diff(expectedFingerprint(), await actualFingerprint(restored)).declaredButMissingFromMigratedDb).toEqual([]);
  });

  it('every row of every table is byte-identical after the round trip (including persisted error text — see PHASE22-02)', async () => {
    const [src, dst] = [await tableDigests(source.client), await tableDigests(restored)];
    expect(Object.keys(dst).length).toBeGreaterThan(30);
    expect(dst).toEqual(src);
    // A backup carries forward whatever text earlier failures wrote into the
    // database — a restore does not "clean" it.
    const [row] = await restored`SELECT error FROM outbox_events WHERE event_type = 'payment.succeeded'`;
    expect(row.error).toBe(LEAK_SHAPED);
  });

  it('integrity constraints are enforced in the restored database (tenant CHECK, unique durable webhook identity, FKs)', async () => {
    expect((await pgError(restored`INSERT INTO events (app_id, tenant_id, category, status) VALUES ('dr-app', '  ', 'payment', 'success')`))?.constraint_name)
      .toBe('chk_events_tenant_id_nonblank');
    expect((await pgError(restored`INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body, tenant_id) VALUES ('stripe', 'evt_p25', '{}'::jsonb, '{}', 't')`))?.code)
      .toBe('23505');
    expect((await pgError(restored`INSERT INTO events (app_id, tenant_id, category, status) VALUES ('no-such-app', 't', 'payment', 'success')`))?.code)
      .toBe('23503');
    expect((await pgError(restored`DELETE FROM applications WHERE slug = 'dr-app'`))?.code).toBe('23503');
  });

  it('restored provider secrets decrypt with the ORIGINAL SECRET_ENCRYPTION_KEY only — a backup is useless without that key', async () => {
    const restoredDb = drizzle(restored, { schema });
    const store = createProviderStateStore(() => restoredDb as never);
    const row = (await store.load('stripe'))!;
    expect(row.secretsVersion).toBe(1);
    expect(row.readSecrets()).toEqual([{ field: 'api_key', label: 'Secret key', value: 'sk_test_p25_original' }]);

    process.env.SECRET_ENCRYPTION_KEY = 'a-different-key-' + randomBytes(16).toString('hex');
    try {
      const again = (await store.load('stripe'))!;
      expect(() => again.readSecrets()).toThrow(ProviderSecretsDecryptError);
    } finally {
      process.env.SECRET_ENCRYPTION_KEY = KEY;
    }
  });
});
