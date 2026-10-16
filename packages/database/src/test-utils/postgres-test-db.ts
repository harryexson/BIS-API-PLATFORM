import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../schema';

/**
 * Test-only helper: a fresh PostgreSQL database, migrated FROM ZERO with this
 * package's real drizzle migrations, plus a postgres-js drizzle handle over
 * it (same SQL as production's neon-http handle). Lives in this package so
 * the drizzle-orm instance (and therefore every table/sql object) is the one
 * the repositories themselves use.
 *
 * Used by suites that run the REAL gateway against a REAL database by
 * swapping only `connection.ts`'s getDb() for this handle, e.g.
 * packages/simulation/src/tenant-isolation.postgres.integration.test.ts.
 * Never imported by production code.
 */
export interface MigratedTestDatabase {
  db: PostgresJsDatabase<typeof schema>;
  client: ReturnType<typeof postgres>;
  url: string;
  dbName: string;
  drop(): Promise<void>;
}

export async function createMigratedTestDatabase(adminUrl: string, prefix = 'bis_test'): Promise<MigratedTestDatabase> {
  const dbName = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const url = u.toString();
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });

  return {
    db,
    client,
    url,
    dbName,
    async drop() {
      await client.end({ timeout: 5 }).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

/**
 * Test-only (Phase 10): a fresh database migrated only THROUGH journal entry
 * `lastIdx`, for proving a later migration upgrades an existing database
 * (with rows written under the older schema) correctly. `migrateRest()`
 * then applies every remaining migration, exactly as a deploy would.
 */
export async function createPartiallyMigratedTestDatabase(
  adminUrl: string,
  lastIdx: number,
  prefix = 'bis_test_up',
): Promise<{ client: ReturnType<typeof postgres>; migrateRest(): Promise<void>; drop(): Promise<void> }> {
  const { cpSync, mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const migrations = path.resolve(__dirname, '../../drizzle');
  const dir = mkdtempSync(path.join(tmpdir(), 'bis-drizzle-partial-'));
  cpSync(migrations, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));

  const dbName = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const client = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: dir });
  return {
    client,
    async migrateRest() {
      await migrate(drizzle(client), { migrationsFolder: migrations });
    },
    async drop() {
      await client.end({ timeout: 5 }).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}
