import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createOutboxEventRepository, type OutboxEventRepository } from './repositories/outbox-events';
import { runOutboxPollOnce, type OutboxStore } from '@company/workers';

/**
 * Phase 22 — gap register C18, against a REAL PostgreSQL server:
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/log-redaction.postgres.integration.test.ts
 *
 * A genuine driver/drizzle error — not a constructed one — reaches one of the
 * worker log sites converted from console.error in this phase: the outbox
 * poller's "could not record outbox dispatch failure". The dispatch error
 * text (carrying a Redis password, a provider key and a phone number) is a
 * bound parameter of the real UPDATE that fails, so the resulting
 * DrizzleQueryError carries all three in its message, its `params` and its
 * stack. Before this phase the poller did
 * `console.error('[outbox_poller] could not record failure ...', failErr)`,
 * which prints exactly that.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');

const REDIS_PASSWORD = 'R3disPhase22pw';
const PROVIDER_KEY = 'sk_live_51HxQ9zP22pgQwErTyUi';
const PHONE = '+265991234567';

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('Phase 22 — a real Postgres error through a converted worker log site is redacted', () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let repo: OutboxEventRepository;
  const name = `bis_p22_${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    client = postgres(urlFor(name), { max: 4, onnotice: () => {} });
    db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = createOutboxEventRepository(() => db as never);
  }, 60_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => undefined);
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  it('outbox poller: failure-record write fails on real Postgres — structured entry, SQLSTATE kept, no secret in the output', async () => {
    const [row] = await client`
      INSERT INTO outbox_events (app_id, event_type, payload)
      VALUES ('app_p22', 'payment_webhook_received', '{"category":"payment"}'::jsonb)
      RETURNING id`;

    // Pass-through store that only records the genuine error fail() throws.
    let failErr: unknown;
    const store: OutboxStore = {
      ...repo,
      fail: (...args: Parameters<OutboxStore['fail']>) =>
        repo.fail(...args).catch((e: unknown) => {
          failErr = e;
          throw e;
        }),
    } as OutboxStore;

    const lines: string[] = [];
    const consoleCalls: unknown[][] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      lines.push(String(chunk));
      return true;
    });
    const cerr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
    const cwarn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
    try {
      await runOutboxPollOnce(
        store,
        async () => {
          // Make the poller's NEXT statement (store.fail's UPDATE) fail for real.
          await client`ALTER TABLE outbox_events RENAME TO outbox_events_p22_hidden`;
          throw new Error(`publish failed via redis://:${REDIS_PASSWORD}@redis:6379 (provider key ${PROVIDER_KEY}, customer ${PHONE})`);
        },
        { batchSize: 1, staleAfterMs: 60_000 },
      );
    } finally {
      stdout.mockRestore();
      cerr.mockRestore();
      cwarn.mockRestore();
      await client`ALTER TABLE IF EXISTS outbox_events_p22_hidden RENAME TO outbox_events`;
    }

    // Control: a genuine drizzle error from the real driver, carrying every secret.
    expect(failErr).toBeInstanceOf(Error);
    expect((failErr as Error).message).toMatch(/^Failed query: update "outbox_events"/);
    expect((failErr as { cause?: { code?: string } }).cause?.code).toBe('42P01');
    const shown = inspect(failErr);
    for (const secret of [REDIS_PASSWORD, PROVIDER_KEY, PHONE]) expect(shown).toContain(secret);

    const entries = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const entry = entries.find((e) => e.errorCode === 'OUTBOX_FAIL_UNRECORDED');
    expect(entry).toBeDefined();
    // First and foremost: no secret anywhere in what was written.
    const raw = lines.join('');
    for (const secret of [REDIS_PASSWORD, PROVIDER_KEY, PHONE]) expect(raw).not.toContain(secret);
    expect(entry).toMatchObject({ level: 'error', operation: 'outbox_poller', status: 'failed', outboxEventId: row.id });
    // This UPDATE's SQL names `claim_token`, so the pre-existing key-word rule
    // (any value containing "token"/"secret"/"auth"/...) redacts the WHOLE
    // message — fail-safe, SQL text lost. Statements without such a word keep
    // their SQL with only the params tail redacted (see the routing test).
    expect(entry.error.message).toBe('[REDACTED]');
    expect(entry.error.params).toBe('[REDACTED]');
    // The diagnosis is still there: the driver's SQLSTATE and message.
    expect(entry.error.cause.code).toBe('42P01');
    expect(entry.error.cause.message).toBe('relation "outbox_events" does not exist');
    expect(consoleCalls).toEqual([]);
  }, 30_000);
});
