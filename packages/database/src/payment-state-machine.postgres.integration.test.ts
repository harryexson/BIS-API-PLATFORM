import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createPaymentAttemptRepository } from './repositories/transactions';
import { createWebhookEventRepository } from './repositories/webhook-events';
import {
  TRANSACTION_STATUSES,
  VALID_TRANSITIONS,
  transactionStatusesAllowedInto,
} from './transaction-status';

/**
 * Phase 6 proof against a REAL PostgreSQL server: the payment state machine
 * (gap register D4 / D11 / PHASE4-03).
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/payment-state-machine.postgres.integration.test.ts
 *
 * Fresh databases are created, migrated FROM ZERO with drizzle's migrator,
 * and dropped afterwards. Production repository code, postgres-js handles;
 * concurrency tests use SEPARATE connection pools so the races are real.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('Phase 6 — payment state machine on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const clients: Array<ReturnType<typeof postgres>> = [];

  async function freshDb(): Promise<{ name: string; client: ReturnType<typeof postgres>; db: PostgresJsDatabase }> {
    const name = `bis_p6_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
    const client = postgres(urlFor(name), { max: 10, onnotice: () => {} });
    clients.push(client);
    return { name, client, db: drizzle(client) };
  }

  function pool(name: string) {
    const client = postgres(urlFor(name), { max: 10, onnotice: () => {} });
    clients.push(client);
    const db = drizzle(client);
    return { client, db, repo: createPaymentAttemptRepository(() => db as never) };
  }

  function migrationsThrough(lastIdx: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bis-drizzle-p6-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  let main: Awaited<ReturnType<typeof freshDb>>;
  let repo: ReturnType<typeof createPaymentAttemptRepository>;
  const pools: Array<ReturnType<typeof pool>> = [];

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    main = await freshDb();
    await migrate(main.db, { migrationsFolder: MIGRATIONS });
    repo = createPaymentAttemptRepository(() => main.db as never);
    for (let i = 0; i < 4; i++) pools.push(pool(main.name));
    // events.app_id references applications.slug (webhook-path tests).
    await main.client`
      INSERT INTO applications (name, slug, description, status, environment)
      VALUES ('Phase 6 test app', 'app_p6', 'payment state machine test', 'active', 'production')`;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  async function seed(status: string, extra: { providerTransactionId?: string | null; providerId?: string } = {}): Promise<string> {
    const [r] = await main.client`
      INSERT INTO transactions (app_id, tenant_id, provider_id, provider_transaction_id, status, amount, currency)
      VALUES ('app_p6', 'ten_p6', ${extra.providerId ?? 'stripe'}, ${extra.providerTransactionId ?? null}, ${status}, '25.00', 'USD')
      RETURNING id`;
    return r.id as string;
  }

  async function statusOf(id: string): Promise<string> {
    const [r] = await main.client`SELECT status FROM transactions WHERE id = ${id}`;
    return r.status as string;
  }

  /** Waits until `n` backends of the test database are blocked waiting on a lock. */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 200; i++) {
      const [{ waiting }] = await admin`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = ${main.name} AND wait_event_type = 'Lock'`;
      if (waiting >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${n} lock waiters`);
  }

  // -------------------------------------------------------------------------
  // Schema: the state machine is enforced by Postgres, not just by code
  // -------------------------------------------------------------------------
  describe('migration 0016', () => {
    it('chk_transactions_status rejects a status outside the state machine (23514), accepts every state in it', async () => {
      const err = await main.client`
        INSERT INTO transactions (app_id, provider_id, status, amount, currency) VALUES ('a', 'stripe', 'succeeded_maybe', 1, 'USD')`.then(
        () => null,
        (e: { code?: string; constraint_name?: string }) => e,
      );
      expect(err?.code).toBe('23514');
      expect(err?.constraint_name).toBe('chk_transactions_status');
      for (const s of TRANSACTION_STATUSES) {
        await expect(seed(s)).resolves.toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('applies to a database already migrated through 0015: legacy statuses untouched, an unrecognised one is surfaced for review (never deleted)', async () => {
      const { client, db } = await freshDb();
      const through15 = migrationsThrough(15);
      try {
        await migrate(db, { migrationsFolder: through15 });
        await client`
          INSERT INTO transactions (app_id, provider_id, provider_transaction_id, status, amount, currency) VALUES
            ('a', 'stripe', 'pi_ok', 'success', 10, 'USD'),
            ('a', 'stripe', 'f2a4b1c0-0000-4000-8000-000000000000', 'pending', 10, 'USD'),
            ('a', 'stripe', 'pi_weird', 'chargeback_maybe', 10, 'USD')`;
        await migrate(db, { migrationsFolder: MIGRATIONS });
        const rows = await client`
          SELECT provider_transaction_id AS ptx, status, reconciliation_reason AS reason, outcome_unknown_at IS NOT NULL AS ambiguous
          FROM transactions ORDER BY provider_transaction_id`;
        expect(rows).toHaveLength(3);
        const by = Object.fromEntries(rows.map((r) => [r.ptx, r]));
        expect(by.pi_ok).toMatchObject({ status: 'success', reason: null, ambiguous: false });
        expect(by['f2a4b1c0-0000-4000-8000-000000000000']).toMatchObject({ status: 'pending', reason: null });
        expect(by.pi_weird.status).toBe('requires_reconciliation');
        expect(by.pi_weird.reason).toContain("'chargeback_maybe'");
        expect(by.pi_weird.ambiguous).toBe(true);
      } finally {
        rmSync(through15, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // The transition graph, exhaustively, through the real SQL guard
  // -------------------------------------------------------------------------
  describe('transitionStatus() — every (from, to) pair', () => {
    it('applies exactly the edges in VALID_TRANSITIONS and cleanly rejects every other one (row unchanged)', async () => {
      const mismatches: string[] = [];
      for (const from of TRANSACTION_STATUSES) {
        for (const to of TRANSACTION_STATUSES) {
          const id = await seed(from);
          const r = await repo.transitionStatus(id, to);
          const expected = (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
          const actual = await statusOf(id);
          if (expected) {
            if (r.outcome !== 'applied' || actual !== to) mismatches.push(`${from}->${to}: expected applied, got ${r.outcome}/${actual}`);
          } else if (r.outcome !== 'rejected' || r.currentStatus !== from || actual !== from) {
            mismatches.push(`${from}->${to}: expected rejected, got ${r.outcome}/${actual}`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('distinguishes not_found, and throws on a status outside the machine (no write attempted)', async () => {
      expect(await repo.transitionStatus('00000000-0000-4000-8000-000000000000', 'success')).toEqual({ outcome: 'not_found' });
      const id = await seed('processing');
      await expect(repo.transitionStatus(id, 'succeeded')).rejects.toThrow(/Invalid transaction status/);
      expect(await statusOf(id)).toBe('processing');
    });

    it('`from` can only narrow the graph, never widen it', async () => {
      const id = await seed('refunded');
      const r = await repo.transitionStatus(id, 'success', { from: ['refunded'] });
      expect(r).toMatchObject({ outcome: 'rejected', currentStatus: 'refunded' });
      const p = await seed('processing');
      expect((await repo.transitionStatus(p, 'success', { from: ['unknown'] })).outcome).toBe('rejected');
    });

    it('no generic transition can move any row back into processing (only the guarded reopen of a never-ambiguous failed attempt can)', async () => {
      expect(transactionStatusesAllowedInto('processing')).toEqual([]);
      for (const from of TRANSACTION_STATUSES) {
        const id = await seed(from);
        expect((await repo.transitionStatus(id, 'processing')).outcome).toBe('rejected');
      }
    });

    it('records ambiguity and resolution bookkeeping', async () => {
      const id = await seed('processing');
      await repo.transitionStatus(id, 'unknown', { reconciliationReason: 'provider_timeout: test' });
      let [r] = await main.client`SELECT outcome_unknown_at, reconciliation_reason, reconciliation_resolved_at FROM transactions WHERE id = ${id}`;
      expect(r.outcome_unknown_at).not.toBeNull();
      expect(r.reconciliation_reason).toBe('provider_timeout: test');
      expect(r.reconciliation_resolved_at).toBeNull();
      await repo.transitionStatus(id, 'success', { fillProviderTransactionId: 'pi_resolved' });
      [r] = await main.client`SELECT status, provider_transaction_id, outcome_unknown_at, reconciliation_resolved_at FROM transactions WHERE id = ${id}`;
      expect(r.status).toBe('success');
      expect(r.provider_transaction_id).toBe('pi_resolved');
      expect(r.outcome_unknown_at).not.toBeNull(); // never cleared
      expect(r.reconciliation_resolved_at).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // D11 — concurrent transitions under REAL concurrency
  // -------------------------------------------------------------------------
  describe('D11: concurrent transitions are decided atomically by Postgres', () => {
    it('two transitions in flight at the SAME time (both valid from the status they started from): exactly one applies, the other is rejected — not silently overwritten', async () => {
      const id = await seed('processing');
      // A third connection holds the row lock so BOTH updates are provably
      // in flight (blocked inside their UPDATE) before either can decide.
      const holder = await pools[3].client.reserve();
      await holder`BEGIN`;
      await holder`SELECT 1 FROM transactions WHERE id = ${id} FOR UPDATE`;
      const a = pools[0].repo.transitionStatus(id, 'success', { fillProviderTransactionId: 'pi_a' });
      const b = pools[1].repo.transitionStatus(id, 'failed');
      await waitForLockWaiters(2);
      await holder`COMMIT`;
      holder.release();
      const [ra, rb] = await Promise.all([a, b]);
      const outcomes = [ra.outcome, rb.outcome].sort();
      expect(outcomes).toEqual(['applied', 'rejected']);
      const winner = ra.outcome === 'applied' ? 'success' : 'failed';
      const loser = ra.outcome === 'applied' ? rb : ra;
      expect(loser).toMatchObject({ outcome: 'rejected', currentStatus: winner });
      expect(await statusOf(id)).toBe(winner);
    });

    it('NEGATIVE CONTROL: the pre-Phase-6 read-then-write updateStatus under the same interleaving lets BOTH "succeed" and the last write silently wins (success overwritten by failed)', async () => {
      // Verbatim logic of HEAD's transactionRepository.updateStatus (D11):
      // read status, validate in JS, then UPDATE ... WHERE id = $id.
      const OLD_TRANSITIONS: Record<string, string[]> = {
        pending: ['processing', 'success', 'failed', 'cancelled', 'unknown'],
        processing: ['success', 'failed', 'refunded', 'unknown'],
        success: ['refunded'],
        failed: ['pending'],
        refunded: [],
        cancelled: [],
        unknown: ['pending', 'success', 'failed', 'refunded'],
      };
      const id = await seed('processing');
      const readA = await pools[0].client`SELECT status FROM transactions WHERE id = ${id}`;
      const readB = await pools[1].client`SELECT status FROM transactions WHERE id = ${id}`;
      const okA = OLD_TRANSITIONS[readA[0].status].includes('success');
      const okB = OLD_TRANSITIONS[readB[0].status].includes('failed');
      expect(okA && okB).toBe(true); // both validated against the same stale snapshot
      await pools[0].client`UPDATE transactions SET status = 'success' WHERE id = ${id}`;
      await pools[1].client`UPDATE transactions SET status = 'failed' WHERE id = ${id}`;
      // A recorded success silently became 'failed' — the defect the atomic guard removes.
      expect(await statusOf(id)).toBe('failed');
    });

    it("a late 'success' webhook racing a refund on a 'success' row: the refund applies once, every late 'success' is rejected, the row ends 'refunded'", async () => {
      const id = await seed('success', { providerTransactionId: 'pi_late_race' });
      const ops = [
        ...Array.from({ length: 4 }, (_, i) => pools[i % 4].repo.transitionStatus(id, 'refunded')),
        ...Array.from({ length: 20 }, (_, i) => pools[i % 4].repo.transitionStatus(id, 'success')),
      ];
      const results = await Promise.all(ops);
      expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
      expect(results.slice(0, 4).filter((r) => r.outcome === 'applied')).toHaveLength(1);
      expect(results.slice(4).every((r) => r.outcome === 'rejected')).toBe(true);
      expect(await statusOf(id)).toBe('refunded');
      // And afterwards nothing can overwrite the refund, whatever arrives.
      for (const to of ['success', 'failed', 'pending', 'unknown', 'partially_refunded']) {
        expect((await repo.transitionStatus(id, to)).outcome).toBe('rejected');
      }
      expect(await statusOf(id)).toBe('refunded');
    });

    it('the same race through the webhook consumer path (persistEffectsOnce): a late charge.succeeded after charge.refunded leaves the row refunded', async () => {
      const webhooks = pools.map((p) => createWebhookEventRepository(() => p.db as never));
      const id = await seed('success', { providerTransactionId: 'pi_wh_race' });
      const effects = (key: string, to: string) => ({
        idempotencyKey: key,
        event: { appId: 'app_p6', category: 'payment_webhook', providerId: 'stripe', status: 'success', decisionReason: 'payment_webhook_received', payload: {} },
        transactionStatus: { providerTransactionId: 'pi_wh_race', toStatus: to, allowedFrom: transactionStatusesAllowedInto(to) },
      });
      const res = await Promise.all([
        webhooks[0].persistEffectsOnce(effects('wh:refund', 'refunded')),
        ...Array.from({ length: 12 }, (_, i) => webhooks[(i + 1) % 4].persistEffectsOnce(effects(`wh:late:${i}`, 'success'))),
      ]);
      expect(res[0].transactionUpdated).toBe(true);
      expect(res.slice(1).every((r) => r.transactionUpdated === false)).toBe(true);
      expect(await statusOf(id)).toBe('refunded');
    });

    it('30 concurrent outcome writes (success / failed / unknown / cancelled, 4 pools) on one processing row: exactly one applies', async () => {
      const id = await seed('processing');
      const targets = ['success', 'failed', 'unknown', 'cancelled'];
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => pools[i % 4].repo.transitionStatus(id, targets[i % 4], { from: ['processing'] })),
      );
      const applied = results.filter((r) => r.outcome === 'applied');
      expect(applied).toHaveLength(1);
      const final = await statusOf(id);
      expect(targets).toContain(final);
      for (const r of results) {
        if (r.outcome === 'rejected') expect(r.currentStatus).toBe(final);
      }
    });
  });
});
