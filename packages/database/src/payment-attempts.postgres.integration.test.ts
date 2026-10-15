import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createPaymentAttemptRepository, UNASSIGNED_PROVIDER_ID } from './repositories/transactions';

/**
 * Phase 3 proof against a REAL PostgreSQL server: the payment-attempt
 * lifecycle that lets the platform's `transactions.id` exist BEFORE any
 * provider call (gap register E7 root cause / D5). Same opt-in as the
 * Phase 2 suite:
 *
 *   TEST_POSTGRES_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres \
 *     npx vitest run packages/database/src/payment-attempts.postgres.integration.test.ts
 *
 * A fresh database is created, migrated FROM ZERO with drizzle's migrator,
 * and dropped afterwards. Production repository code, postgres-js handle.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');

describe.skipIf(!ADMIN_URL)('Phase 3 — payment attempts on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let repo: ReturnType<typeof createPaymentAttemptRepository>;
  const dbName = `bis_p3_${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    client = postgres(u.toString(), { max: 10, onnotice: () => {} });
    db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = createPaymentAttemptRepository(() => db as never);
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  const base = { appId: 'app_p3', tenantId: 'ten_p3', amount: '40', currency: 'USD', paymentMethod: 'card' };

  it('allocate() creates a processing row with a real UUID id and no provider transaction id, before any provider call', async () => {
    const row = await repo.allocate({ ...base, idempotencyKey: 'k-alloc' });
    expect(row).toBeDefined();
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row!.status).toBe('processing');
    expect(row!.providerId).toBe(UNASSIGNED_PROVIDER_ID);
    expect(row!.providerTransactionId).toBeNull();
  });

  it('a second allocate() for the same (app, tenant, key) returns undefined via ON CONFLICT DO NOTHING — no 23505 thrown', async () => {
    const again = await repo.allocate({ ...base, idempotencyKey: 'k-alloc' });
    expect(again).toBeUndefined();
    const [{ n }] = await client`SELECT count(*)::int AS n FROM transactions WHERE idempotency_key = 'k-alloc'`;
    expect(n).toBe(1);
  });

  it('20 concurrent allocate() calls for one key: exactly one wins, no errors', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => repo.allocate({ ...base, idempotencyKey: 'k-race' })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const [{ n }] = await client`SELECT count(*)::int AS n FROM transactions WHERE idempotency_key = 'k-race'`;
    expect(n).toBe(1);
  });

  it('keyless allocations never collide (NULL keys), each gets its own id', async () => {
    const a = await repo.allocate({ ...base });
    const b = await repo.allocate({ ...base });
    expect(a && b).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
  });

  it('recordOutcome() only updates a row that is still processing', async () => {
    const row = (await repo.allocate({ ...base, idempotencyKey: 'k-outcome' }))!;
    const done = await repo.recordOutcome(row.id, { providerId: 'stripe', providerTransactionId: 'pi_1', status: 'success' });
    expect(done!.status).toBe('success');
    expect(done!.providerTransactionId).toBe('pi_1');
    expect(done!.providerId).toBe('stripe');
    // A late/duplicate outcome write cannot overwrite a recorded outcome.
    const late = await repo.recordOutcome(row.id, { providerId: 'nmi', providerTransactionId: 'x', status: 'failed' });
    expect(late).toBeUndefined();
    const [r] = await client`SELECT status, provider_transaction_id FROM transactions WHERE id = ${row.id}`;
    expect(r).toEqual({ status: 'success', provider_transaction_id: 'pi_1' });
  });

  it('reopenFailed() reopens ONLY a failed row that never got a provider transaction id, keeping the same id', async () => {
    const routingFailed = (await repo.allocate({ ...base, idempotencyKey: 'k-reopen' }))!;
    await repo.recordOutcome(routingFailed.id, { providerId: 'failed_route', providerTransactionId: null, status: 'failed' });
    const reopened = await repo.reopenFailed(routingFailed.id);
    expect(reopened!.id).toBe(routingFailed.id);
    expect(reopened!.status).toBe('processing');
    // Only once: a concurrent second reopen loses.
    expect(await repo.reopenFailed(routingFailed.id)).toBeUndefined();

    const declined = (await repo.allocate({ ...base, idempotencyKey: 'k-declined' }))!;
    await repo.recordOutcome(declined.id, { providerId: 'stripe', providerTransactionId: 'pi_declined', status: 'failed' });
    expect(await repo.reopenFailed(declined.id)).toBeUndefined(); // a provider decline is NOT re-attempted under the same key

    const succeeded = (await repo.allocate({ ...base, idempotencyKey: 'k-success' }))!;
    await repo.recordOutcome(succeeded.id, { providerId: 'stripe', providerTransactionId: 'pi_ok', status: 'success' });
    expect(await repo.reopenFailed(succeeded.id)).toBeUndefined();
  });
});
