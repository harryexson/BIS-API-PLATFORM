import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import Redis from 'ioredis';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createOutboxEventRepository, type ClaimedOutboxEvent, type OutboxEventRepository } from './repositories/outbox-events';
import { createWebhookEventRepository, type WebhookEventRepository } from './repositories/webhook-events';
import { transactionStatusesAllowedInto } from './transaction-status';
import {
  createWorkerConfig,
  createPaymentWebhookProcessor,
  runOutboxPollOnce,
  eventBusOutboxDispatcher,
  type OutboxStore,
  type OutboxDispatcher,
  type JobDeps,
  type Job,
} from '@company/workers';
import { EventBus } from '@company/events';
import { freePort, redisServerBinaryAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Phase 5 proof — transactional-outbox correctness end to end — against a
 * REAL PostgreSQL server (and a REAL redis-server for the Redis-failure
 * case), never a mock:
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/outbox.postgres.integration.test.ts
 *
 * Fresh database migrated FROM ZERO with drizzle's own migrator over this
 * repo's drizzle/ folder, dropped afterwards. Production repository and
 * worker code; postgres-js handle (same PgDialect / SQL as neon-http).
 *
 * Covers gap register D10 (claim over-claims, rescue keyed on created_at,
 * failure terminal with no retry) plus dead-letter/replay and the atomic
 * business-state + outbox write at the commit boundary.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** drizzle wraps driver errors ("Failed query: ..."); the Postgres SQLSTATE / message is on the cause. */
const pgCode = (e: unknown): string | undefined => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code ?? err?.cause?.code;
};
const pgMessage = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } } | null;
  return `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
};

async function waitFor(pred: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(25);
  }
}

describe.skipIf(!ADMIN_URL)('Phase 5 — transactional outbox on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const clients: Array<ReturnType<typeof postgres>> = [];
  let main: { client: ReturnType<typeof postgres>; db: PostgresJsDatabase; url: string };
  let repo: OutboxEventRepository;
  let webhookRepo: WebhookEventRepository;

  async function freshDb() {
    const name = `bis_p5_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = urlFor(name);
    const client = postgres(url, { max: 10, onnotice: () => {} });
    clients.push(client);
    return { name, url, client, db: drizzle(client) };
  }

  function connect(url: string, max = 4) {
    const client = postgres(url, { max, onnotice: () => {} });
    clients.push(client);
    return { client, db: drizzle(client) };
  }

  /** An independent outbox repository with its OWN connection pool (a separate worker replica). */
  function replicaRepo(max = 3): OutboxEventRepository {
    const { db } = connect(main.url, max);
    return createOutboxEventRepository(() => db as never);
  }

  function migrationsThrough(lastIdx: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bis-drizzle-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  /** n pending rows with strictly increasing created_at (row 1 oldest). */
  async function insertPending(n: number, opts: { appId?: string; eventType?: string; createdSecondsAgo?: number } = {}): Promise<string[]> {
    const base = opts.createdSecondsAgo ?? n;
    const rows = await main.client`
      INSERT INTO outbox_events (app_id, event_type, payload, created_at)
      SELECT ${opts.appId ?? 'app_p5'}, ${opts.eventType ?? 'payment_webhook_received'},
             jsonb_build_object('n', g, 'category', 'payment', 'providerId', 'stripe'),
             now() - make_interval(secs => (${base}::int - g + 1))
      FROM generate_series(1, ${n}::int) AS g
      RETURNING id, created_at`;
    // (drizzle's postgres-js setup returns timestamps as strings on this shared client)
    const t = (v: unknown) => new Date(v as string).getTime();
    return [...rows].sort((a, b) => t(a.created_at) - t(b.created_at)).map((r) => r.id as string);
  }

  async function statusCounts(): Promise<Record<string, number>> {
    const rows = await main.client`SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status`;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status as string] = r.n as number;
    return out;
  }

  async function row(id: string) {
    const [r] = await main.client`SELECT * FROM outbox_events WHERE id = ${id}`;
    return r;
  }

  /** A dispatcher that records what it was handed (the "real-world effect" log). */
  function recorder() {
    const seen: string[] = [];
    const dispatch: OutboxDispatcher = async (r) => {
      seen.push(r.id);
    };
    return { seen, dispatch };
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    main = await freshDb();
    await migrate(main.db, { migrationsFolder: MIGRATIONS });
    repo = createOutboxEventRepository(() => main.db as never);
    webhookRepo = createWebhookEventRepository(() => main.db as never);
    // events.app_id references applications.slug.
    await main.client`
      INSERT INTO applications (name, slug, description, status, environment)
      VALUES ('Phase 5 test app', 'app_p5', 'outbox integration test', 'active', 'production')`;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 }).catch(() => undefined);
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // Migration 0015
  // -------------------------------------------------------------------------
  describe('migration 0015 (from zero, and over legacy data)', () => {
    it('adds the claim/lease/dead-letter columns and a status CHECK that rejects the old never-retried "failed" state', async () => {
      const cols = await main.client`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox_events' ORDER BY column_name`;
      const names = cols.map((c) => c.column_name);
      for (const c of ['attempts', 'claimed_at', 'claim_token', 'next_attempt_at', 'dead_at', 'replay_count', 'updated_at']) {
        expect(names).toContain(c);
      }
      let code: string | undefined;
      try {
        await main.client`INSERT INTO outbox_events (app_id, event_type, payload, status) VALUES ('a', 'e', '{}'::jsonb, 'failed')`;
      } catch (e) {
        code = pgCode(e);
      }
      expect(code).toBe('23514');
    });

    it('over a database migrated through 0014 with legacy rows: failed → dead (listable/replayable), stranded processing rows get a claim time and are rescued, pending untouched — nothing deleted', async () => {
      const legacy = await freshDb();
      await migrate(legacy.db, { migrationsFolder: migrationsThrough(14) });
      // The state the old code produced: claimBatch(10) over 7 pending rows
      // flipped ALL of them to 'processing' (4 here stand in for the stranded
      // ones), and fail() wrote a terminal 'failed' nothing ever retried.
      await legacy.client`
        INSERT INTO outbox_events (app_id, event_type, payload, status, error, created_at) VALUES
          ('a', 'e', '{"k":"p1"}', 'pending', NULL, now() - interval '1 hour'),
          ('a', 'e', '{"k":"p2"}', 'pending', NULL, now() - interval '1 hour'),
          ('a', 'e', '{"k":"p3"}', 'pending', NULL, now() - interval '1 hour'),
          ('a', 'e', '{"k":"s1"}', 'processing', NULL, now() - interval '2 hours'),
          ('a', 'e', '{"k":"s2"}', 'processing', NULL, now() - interval '2 hours'),
          ('a', 'e', '{"k":"s3"}', 'processing', NULL, now() - interval '2 hours'),
          ('a', 'e', '{"k":"s4"}', 'processing', NULL, now() - interval '2 hours'),
          ('a', 'e', '{"k":"f1"}', 'failed', 'Error: redis down', now() - interval '3 hours'),
          ('a', 'e', '{"k":"f2"}', 'failed', 'Error: timeout', now() - interval '3 hours')`;

      await migrate(legacy.db, { migrationsFolder: MIGRATIONS });

      const rows = await legacy.client`SELECT payload->>'k' AS k, status, claimed_at, dead_at, error, attempts FROM outbox_events ORDER BY payload->>'k'`;
      expect(rows).toHaveLength(9); // nothing deleted
      const byK = Object.fromEntries(rows.map((r) => [r.k, r]));
      for (const k of ['p1', 'p2', 'p3']) {
        expect(byK[k].status).toBe('pending');
        expect(byK[k].claimed_at).toBeNull();
      }
      for (const k of ['s1', 's2', 's3', 's4']) {
        expect(byK[k].status).toBe('processing');
        expect(byK[k].claimed_at).not.toBeNull(); // backfilled → judged by the new stale rule
      }
      expect(byK.f1.status).toBe('dead');
      expect(byK.f1.dead_at).not.toBeNull();
      expect(byK.f1.error).toBe('Error: redis down'); // evidence preserved

      const legacyRepo = createOutboxEventRepository(() => legacy.db as never);
      // The stranded rows are recoverable now (staleAfterMs 0 = "the window has passed").
      const rescue = await legacyRepo.rescueStale({ staleAfterMs: 0 });
      expect(rescue.requeued).toHaveLength(4);
      expect(rescue.deadLettered).toHaveLength(0);
      expect(await legacyRepo.listDead()).toHaveLength(2);
      const deadId = (await legacy.client`SELECT id FROM outbox_events WHERE payload->>'k' = 'f1'`)[0].id as string;
      expect((await legacyRepo.replayDead(deadId))?.status).toBe('pending');
      const claimed = await legacyRepo.claimBatch(100);
      expect(claimed.map((r) => (r.payload as { k: string }).k).sort()).toEqual(['f1', 'p1', 'p2', 'p3', 's1', 's2', 's3', 's4']);
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 1 — claimBatch claims exactly N, under real concurrency
  // -------------------------------------------------------------------------
  describe('claimBatch — exactly batchLimit rows, nothing stranded (D10)', () => {
    beforeEach(async () => {
      await main.client`TRUNCATE outbox_events`;
    });

    it('NEGATIVE CONTROL: the pre-Phase-5 claim SQL flips every pending row to processing and returns only batchLimit of them', async () => {
      await insertPending(500);
      // Literally the old claimBatch: UPDATE ... WHERE status='pending' RETURNING *, then .slice(0, 10) in JS.
      const all = await main.client`UPDATE outbox_events SET status = 'processing' WHERE status = 'pending' RETURNING id`;
      const returnedToCaller = all.slice(0, 10);
      expect(returnedToCaller).toHaveLength(10);
      expect(await statusCounts()).toEqual({ processing: 500 }); // 490 stranded with nobody working on them
    });

    it('claims exactly batchLimit rows (oldest first), each with its own claim token, and leaves every other row genuinely pending', async () => {
      const ids = await insertPending(500);
      const claimed = await repo.claimBatch(10);
      expect(claimed.map((r) => r.id)).toEqual(ids.slice(0, 10));
      expect(new Set(claimed.map((r) => r.claimToken)).size).toBe(10);
      for (const r of claimed) {
        expect(r.status).toBe('processing');
        expect(r.attempts).toBe(1);
        expect(r.claimedAt).toBeInstanceOf(Date);
      }
      expect(await statusCounts()).toEqual({ processing: 10, pending: 490 });
      const [{ limbo }] = await main.client`
        SELECT count(*)::int AS limbo FROM outbox_events
        WHERE status = 'pending' AND (claimed_at IS NOT NULL OR claim_token IS NOT NULL OR attempts <> 0)`;
      expect(limbo).toBe(0);
    });

    it('5 concurrent claimers on 5 separate connection pools: every row claimed exactly once — none double-claimed, none skipped', async () => {
      const ids = await insertPending(500);
      const claimers = Array.from({ length: 5 }, () => replicaRepo(2));

      // Round 1: five simultaneous batch claims.
      const first = await Promise.all(claimers.map((c) => c.claimBatch(10)));
      const firstIds = first.flat().map((r) => r.id);
      expect(firstIds).toHaveLength(50);
      expect(new Set(firstIds).size).toBe(50);
      expect(await statusCounts()).toEqual({ processing: 50, pending: 450 });

      // Then all five drain the table concurrently.
      const got: string[][] = claimers.map(() => []);
      await Promise.all(
        claimers.map(async (c, i) => {
          for (;;) {
            const batch = await c.claimBatch(10);
            if (batch.length === 0) return;
            got[i].push(...batch.map((r) => r.id));
          }
        }),
      );
      const all = [...firstIds, ...got.flat()];
      expect(all).toHaveLength(500);
      expect(new Set(all)).toEqual(new Set(ids));
      expect(got.filter((g) => g.length > 0).length).toBeGreaterThan(1); // genuinely shared, not one claimer doing everything
      const [{ maxAttempts, n }] = await main.client`SELECT max(attempts)::int AS "maxAttempts", count(*)::int AS n FROM outbox_events WHERE status = 'processing'`;
      expect(n).toBe(500);
      expect(maxAttempts).toBe(1); // no row was ever claimed twice
    });

    it('FOR UPDATE SKIP LOCKED: a claimer is not blocked by rows another transaction holds locked — it takes exactly the next batchLimit rows, even when the planner picks a re-scanning nested loop (NEGATIVE CONTROL: the IN (...) form over-claims there); the locked ones are claimable after release', async () => {
      const ids = await insertPending(30);
      const locker = connect(main.url, 1);
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holding = locker.client.begin(async (tx) => {
        await tx`SELECT id FROM outbox_events ORDER BY created_at LIMIT 10 FOR UPDATE`;
        locked();
        await released;
      });
      try {
        await isLocked;

        // A connection whose planner is pushed onto the plan shape that bit us
        // (nested-loop semi join that re-scans the locking sub-select).
        const nlConn = postgres(main.url, {
          max: 1,
          onnotice: () => {},
          connection: { enable_hashjoin: 'off', enable_mergejoin: 'off', enable_material: 'off' },
        });
        clients.push(nlConn);

        // NEGATIVE CONTROL — the `id IN (sub-select ... LIMIT 10 FOR UPDATE SKIP LOCKED)`
        // form (what this repository first used, and Phase 4's sweeper used),
        // run and rolled back on that connection:
        const ROLLBACK = new Error('rollback');
        let overClaimed = -1;
        await nlConn
          .begin(async (tx) => {
            const r = await tx`
              UPDATE outbox_events SET status = 'processing'
              WHERE id IN (SELECT id FROM outbox_events WHERE status = 'pending' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
                AND status = 'pending'
              RETURNING id`;
            overClaimed = r.length;
            throw ROLLBACK;
          })
          .catch((e) => {
            if (e !== ROLLBACK) throw e;
          });
        expect(overClaimed).toBeGreaterThan(10);
        expect(await statusCounts()).toEqual({ pending: 30 }); // rolled back

        // The production claim on the SAME planner settings: exactly 10, the next 10, no waiting.
        const nlRepo = createOutboxEventRepository(() => drizzle(nlConn) as never);
        const started = Date.now();
        const batch = await Promise.race([
          nlRepo.claimBatch(10),
          sleep(5_000).then(() => {
            throw new Error('claimBatch blocked on locked rows');
          }),
        ]);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(batch.map((r) => r.id)).toEqual(ids.slice(10, 20));
        expect(await statusCounts()).toEqual({ processing: 10, pending: 20 });

        // And with default planner settings from another pool.
        const other = replicaRepo(1);
        const more = await other.claimBatch(10);
        expect(more.map((r) => r.id)).toEqual(ids.slice(20, 30));
        release();
        await holding;
        const after = await other.claimBatch(10);
        expect(after.map((r) => r.id)).toEqual(ids.slice(0, 10));
        expect(await statusCounts()).toEqual({ processing: 30 });
      } finally {
        release();
        await holding.catch(() => undefined);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 2 — crash recovery keyed on claim time, not creation time
  // -------------------------------------------------------------------------
  describe('stale-claim rescue (D10)', () => {
    beforeEach(async () => {
      await main.client`TRUNCATE outbox_events`;
    });

    it('a worker PROCESS killed with SIGKILL mid-dispatch: its row is NOT rescued while the claim is fresh, then IS rescued once stale and completed by a different worker exactly once', async () => {
      const ids = await insertPending(3);

      // A real, separate OS process claims the oldest row and dies mid-dispatch.
      // Launched as `node --import tsx <fixture>` (not the node_modules/.bin/tsx
      // CLI): the CLI runs the script in a grandchild and re-exits with code
      // 137, so the SIGKILL would not be observable on the process we spawned.
      let stdout = '';
      let signal: string | null | undefined;
      let exitCode: number | null | undefined;
      const spawned = run(process.execPath, ['--import', 'tsx', 'packages/database/src/test-fixtures/outbox-crash-worker.ts', main.url, '1'], {
        cwd: REPO_ROOT,
        timeout: 60_000,
      });
      const childPid = spawned.child.pid;
      try {
        await spawned;
      } catch (e) {
        const err = e as { stdout?: string; signal?: string | null; code?: number | null };
        stdout = err.stdout ?? '';
        signal = err.signal;
        exitCode = err.code;
      }
      expect({ signal, exitCode }).toEqual({ signal: 'SIGKILL', exitCode: null }); // killed, never exited
      const crashed = JSON.parse(stdout.trim().split('\n').pop()!);
      expect(crashed.dispatching).toBe(ids[0]);
      expect(crashed.pid).toBe(childPid); // the claimer IS the process that was killed
      expect(crashed.pid).not.toBe(process.pid);
      const orphan = await row(ids[0]);
      expect(orphan.status).toBe('processing');
      expect(orphan.claim_token).toBe(crashed.claimToken);

      // A different worker polls right away: the orphan's claim is fresh, so
      // it is left alone (its owner could still be alive); the other rows flow.
      const workerB = replicaRepo();
      const b = recorder();
      const cfg = { staleAfterMs: 1_500, batchSize: 10 };
      const r1 = await runOutboxPollOnce(workerB, b.dispatch, cfg);
      expect(r1.rescued).toBe(0);
      expect(b.seen.sort()).toEqual([ids[1], ids[2]].sort());
      expect((await row(ids[0])).status).toBe('processing');

      // After the stale window the orphan is rescued and delivered — once.
      await sleep(1_700);
      const r2 = await runOutboxPollOnce(workerB, b.dispatch, cfg);
      expect(r2.rescued).toBe(1);
      expect(r2.completed).toBe(1);
      expect(b.seen.filter((id) => id === ids[0])).toHaveLength(1);
      const done = await row(ids[0]);
      expect(done.status).toBe('completed');
      expect(done.attempts).toBe(2); // the crash counted as an attempt
      expect(done.claim_token).toBeNull();

      // The dead process's token is worthless: it can neither complete nor fail the row.
      expect(await repo.complete(ids[0], crashed.claimToken)).toBe(false);
      expect(await repo.fail(ids[0], crashed.claimToken, 'late')).toBeNull();
      expect((await row(ids[0])).status).toBe('completed');

      // And nothing else happens on further polls.
      const r3 = await runOutboxPollOnce(workerB, b.dispatch, cfg);
      expect(r3.claimed + r3.rescued).toBe(0);
      expect(b.seen).toHaveLength(3);
    }, 90_000);

    it('a row created long ago but claimed just now is NOT rescued from its live owner (claimed_at decides) — NEGATIVE CONTROL: the old created_at predicate would have yanked it', async () => {
      const [id] = await insertPending(1, { createdSecondsAgo: 86_400 }); // created a day ago
      const owner = replicaRepo();
      const [claimed] = await owner.claimBatch(1);
      expect(claimed.id).toBe(id);

      // The old rescue predicate (status='processing' AND created_at < now() - 5 min) selects it:
      const old = await main.client`SELECT id FROM outbox_events WHERE status = 'processing' AND created_at < now() - interval '5 minutes'`;
      expect(old.map((r) => r.id)).toEqual([id]);

      // The new one does not:
      const rescue = await replicaRepo().rescueStale({ staleAfterMs: 5 * 60_000 });
      expect(rescue.requeued).toHaveLength(0);
      expect(rescue.deadLettered).toHaveLength(0);
      expect((await row(id)).claim_token).toBe(claimed.claimToken);
      expect(await owner.complete(id, claimed.claimToken)).toBe(true);
    });

    it('a live owner that keeps renewing its claim is never rescued, even well past the stale window; once it stops, it is', async () => {
      const [id] = await insertPending(1);
      const owner = replicaRepo();
      const sweeper = replicaRepo();
      const [claimed] = await owner.claimBatch(1);
      const staleAfterMs = 600;

      let rescuedWhileAlive = 0;
      const until = Date.now() + 1_800; // 3x the stale window
      await Promise.all([
        (async () => {
          while (Date.now() < until) {
            expect(await owner.renewClaim(id, claimed.claimToken)).toBe(true);
            await sleep(150);
          }
        })(),
        (async () => {
          while (Date.now() < until) {
            rescuedWhileAlive += (await sweeper.rescueStale({ staleAfterMs })).requeued.length;
            await sleep(100);
          }
        })(),
      ]);
      expect(rescuedWhileAlive).toBe(0);
      expect((await row(id)).status).toBe('processing');

      await sleep(staleAfterMs + 200); // owner went silent
      const rescue = await sweeper.rescueStale({ staleAfterMs });
      expect(rescue.requeued.map((r) => r.id)).toEqual([id]);
      expect(await owner.renewClaim(id, claimed.claimToken)).toBe(false); // fenced out
    });

    it('fencing: after a rescue and re-claim by worker B, the old owner A can no longer renew, complete or fail the row', async () => {
      const [id] = await insertPending(1);
      const a = replicaRepo();
      const b = replicaRepo();
      const [ca] = await a.claimBatch(1);
      await sleep(350);
      expect((await b.rescueStale({ staleAfterMs: 300 })).requeued).toHaveLength(1);
      const [cb] = await b.claimBatch(1);
      expect(cb.id).toBe(id);
      expect(cb.claimToken).not.toBe(ca.claimToken);
      expect(await a.renewClaim(id, ca.claimToken)).toBe(false);
      expect(await a.complete(id, ca.claimToken)).toBe(false);
      expect(await a.fail(id, ca.claimToken, 'stale owner')).toBeNull();
      expect((await row(id)).claim_token).toBe(cb.claimToken);
      expect(await b.complete(id, cb.claimToken)).toBe(true);
    });

    it('a row that keeps crashing its worker is dead-lettered after maxAttempts instead of being rescued forever', async () => {
      const [id] = await insertPending(1);
      const maxAttempts = 3;
      const outcomes: string[] = [];
      for (let i = 0; i < 5; i++) {
        const claimed = await repo.claimBatch(1);
        if (claimed.length === 0) break;
        // ... the worker dies here: no complete, no fail ...
        await sleep(250);
        const rescue = await repo.rescueStale({ staleAfterMs: 200, maxAttempts });
        outcomes.push(rescue.requeued.length ? 'requeued' : rescue.deadLettered.length ? 'dead' : 'none');
      }
      expect(outcomes).toEqual(['requeued', 'requeued', 'dead']);
      const r = await row(id);
      expect(r.status).toBe('dead');
      expect(r.attempts).toBe(3);
      expect(r.dead_at).not.toBeNull();
      expect(r.error).toMatch(/stale/);
      expect((await repo.listDead()).map((d) => d.id)).toEqual([id]);
      expect(await repo.claimBatch(10)).toHaveLength(0);
    });

    it('dispatch failures retry with backoff (not claimable early) and dead-letter after maxAttempts — never a silent terminal state', async () => {
      const [id] = await insertPending(1);
      let calls = 0;
      const failing: OutboxDispatcher = async () => {
        calls++;
        throw new Error(`downstream 503 #${calls}`);
      };

      const cfg = { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 400, staleAfterMs: 60_000 };
      const r1 = await runOutboxPollOnce(repo, failing, cfg);
      expect(r1.retried).toBe(1);
      const afterFirst = await row(id);
      expect(afterFirst.status).toBe('pending');
      expect(afterFirst.error).toMatch(/downstream 503 #1/);
      // In backoff: not claimable yet.
      const r2 = await runOutboxPollOnce(repo, failing, cfg);
      expect(r2.claimed).toBe(0);
      expect(calls).toBe(1);

      await waitFor(async () => {
        await runOutboxPollOnce(repo, failing, cfg);
        return (await row(id)).status === 'dead';
      }, 'row dead-lettered');
      expect(calls).toBe(3);
      const dead = await row(id);
      expect(dead.attempts).toBe(3);
      expect(dead.error).toMatch(/downstream 503 #3/);
      expect(await statusCounts()).toEqual({ dead: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 3 — dead letter + idempotent replay
  // -------------------------------------------------------------------------
  describe('dead letters and replay', () => {
    beforeEach(async () => {
      await main.client`TRUNCATE outbox_events`;
    });

    async function makeDead(n: number): Promise<string[]> {
      const ids = await insertPending(n);
      await runOutboxPollOnce(
        repo,
        async () => {
          throw new Error('receiver down');
        },
        { maxAttempts: 1, batchSize: n },
      );
      expect(await statusCounts()).toEqual({ dead: n });
      return ids;
    }

    it('racing replays of one dead letter (6 callers, separate pools): exactly one wins; 3 concurrent pollers then deliver it exactly once', async () => {
      const [id] = await makeDead(1);
      const results = await Promise.all(Array.from({ length: 6 }, () => replicaRepo(1).replayDead(id)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const replayed = await row(id);
      expect(replayed.status).toBe('pending');
      expect(replayed.replay_count).toBe(1);
      expect(replayed.attempts).toBe(0); // documented policy: attempt budget reset on replay
      expect(replayed.error).toBe('Error: receiver down'); // audit trail kept until a new attempt

      const effects: string[] = [];
      const dispatch: OutboxDispatcher = async (r) => {
        await sleep(20);
        effects.push(r.id);
      };
      await Promise.all(Array.from({ length: 3 }, () => runOutboxPollOnce(replicaRepo(2), dispatch)));
      expect(effects).toEqual([id]);
      expect((await row(id)).status).toBe('completed');

      // Replaying again is refused: it is no longer dead.
      expect(await repo.replayDead(id)).toBeUndefined();
      await runOutboxPollOnce(repo, dispatch);
      expect(effects).toEqual([id]);
    });

    it('a completed (or pending/processing) event can never be replayed — no re-dispatch of something already delivered or in flight', async () => {
      const [done, inflight, waiting] = await insertPending(3);
      const [c] = await repo.claimBatch(1);
      expect(c.id).toBe(done);
      await repo.complete(done, c.claimToken);
      const [c2] = await repo.claimBatch(1);
      expect(c2.id).toBe(inflight);
      for (const id of [done, inflight, waiting]) {
        expect(await repo.replayDead(id)).toBeUndefined();
      }
      expect((await row(done)).status).toBe('completed');
      expect((await row(inflight)).status).toBe('processing');
      expect((await row(waiting)).status).toBe('pending');
      expect((await row(done)).replay_count).toBe(0);
    });

    it('replayDeadBatch from two pools racing per-id replays: every dead letter replayed exactly once, then delivered exactly once each', async () => {
      const ids = await makeDead(20);
      expect((await repo.listDead({ limit: 100 })).map((r) => r.id).sort()).toEqual([...ids].sort());
      const [batchA, batchB, singles] = await Promise.all([
        replicaRepo(1).replayDeadBatch({ limit: 100 }),
        replicaRepo(1).replayDeadBatch({ limit: 100 }),
        Promise.all(ids.map((id) => replicaRepo(1).replayDead(id))),
      ]);
      const winners = [...batchA.map((r) => r.id), ...batchB.map((r) => r.id), ...singles.filter(Boolean).map((r) => r!.id)];
      expect(winners.sort()).toEqual([...ids].sort());
      const [{ bad }] = await main.client`SELECT count(*)::int AS bad FROM outbox_events WHERE replay_count <> 1 OR status <> 'pending'`;
      expect(bad).toBe(0);

      const rec = recorder();
      await Promise.all(Array.from({ length: 3 }, () => runOutboxPollOnce(replicaRepo(2), rec.dispatch, { batchSize: 5 })));
      while ((await runOutboxPollOnce(repo, rec.dispatch)).claimed > 0);
      expect(rec.seen.sort()).toEqual([...ids].sort());
    });

    it('ambiguous outcome (delivered, then the completion write fails): re-dispatched with the SAME event id after the stale window, so an idempotent receiver applies the effect once', async () => {
      // A real HTTP receiver that de-duplicates on the event id it is given.
      const requests: string[] = [];
      const applied = new Set<string>();
      let bodyMismatch = 0;
      const server: Server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const eventId = String(req.headers['x-outbox-event-id']);
          requests.push(eventId);
          if (JSON.parse(body).id !== eventId) bodyMismatch++;
          applied.add(eventId); // idempotent effect keyed on the id
          res.writeHead(200).end('ok');
        });
      });
      const port = await freePort();
      await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
      try {
        const httpDispatch: OutboxDispatcher = async (r: ClaimedOutboxEvent) => {
          const res = await fetch(`http://127.0.0.1:${port}/hook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-outbox-event-id': r.id },
            body: JSON.stringify({ id: r.id, type: r.eventType, payload: r.payload }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        };
        const [id] = await insertPending(1);

        // Simulated DB failure exactly at the completion write.
        let failCompleteOnce = true;
        const flaky: OutboxStore = {
          claimBatch: (n) => repo.claimBatch(n),
          renewClaim: (i, t) => repo.renewClaim(i, t),
          fail: (i, t, e, p) => repo.fail(i, t, e, p),
          rescueStale: (o) => repo.rescueStale(o),
          complete: async (i, t) => {
            if (failCompleteOnce) {
              failCompleteOnce = false;
              throw new Error('connection terminated unexpectedly');
            }
            return repo.complete(i, t);
          },
        };
        const cfg = { staleAfterMs: 400 };
        const r1 = await runOutboxPollOnce(flaky, httpDispatch, cfg);
        expect(r1.completionUnrecorded).toBe(1);
        expect((await row(id)).status).toBe('processing'); // not lost, not falsely completed

        await sleep(500);
        const r2 = await runOutboxPollOnce(flaky, httpDispatch, cfg);
        expect(r2.rescued).toBe(1);
        expect(r2.completed).toBe(1);
        expect((await row(id)).status).toBe('completed');
        expect(requests).toEqual([id, id]); // at least once on the wire...
        expect([...applied]).toEqual([id]); // ...exactly once in effect, via the stable id
        expect(bodyMismatch).toBe(0);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 4 — business state + outbox commit atomically
  // -------------------------------------------------------------------------
  describe('atomic business-state + events + outbox write (persistEffectsOnce)', () => {
    async function seedTx(providerTxId: string, status: string): Promise<string> {
      const [r] = await main.client`
        INSERT INTO transactions (app_id, tenant_id, provider_id, provider_transaction_id, status, amount, currency)
        VALUES ('app_p5', 'default', 'stripe', ${providerTxId}, ${status}, '10.00', 'USD') RETURNING id`;
      return r.id as string;
    }

    function refundEffects(key: string, providerTxId: string) {
      return {
        idempotencyKey: key,
        event: {
          appId: 'app_p5',
          category: 'payment_webhook',
          providerId: 'stripe',
          status: 'success',
          decisionReason: 'payment_webhook_received',
          payload: { type: 'charge.refunded', data: { object: { id: providerTxId } } },
        },
        outbox: { appId: 'app_p5', eventType: 'payment_webhook_received', payload: { id: key, category: 'payment' } },
        transactionStatus: { providerTransactionId: providerTxId, toStatus: 'refunded', allowedFrom: transactionStatusesAllowedInto('refunded') },
      };
    }

    async function snapshot(key: string, txId: string) {
      const [{ ev }] = await main.client`SELECT count(*)::int AS ev FROM events WHERE idempotency_key = ${key}`;
      const [{ ob }] = await main.client`SELECT count(*)::int AS ob FROM outbox_events WHERE payload->>'id' = ${key}`;
      const [{ status }] = await main.client`SELECT status FROM transactions WHERE id = ${txId}`;
      return { events: ev as number, outbox: ob as number, txStatus: status as string };
    }

    beforeAll(async () => {
      // A fault that fires AT COMMIT of the implicit transaction — i.e. after
      // every write in the statement has executed — when armed.
      await main.client.unsafe(`
        CREATE TABLE p5_commit_fault (armed boolean NOT NULL);
        INSERT INTO p5_commit_fault VALUES (false);
        CREATE FUNCTION p5_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE msg text;
        BEGIN
          IF (SELECT armed FROM p5_commit_fault) THEN
            msg := format('p5 simulated failure at COMMIT: outbox row %s written, events rows for key=%s, transaction status=%s',
              NEW.id,
              (SELECT count(*) FROM events WHERE idempotency_key = NEW.payload->>'id'),
              (SELECT string_agg(status, ',') FROM transactions WHERE provider_transaction_id = NEW.payload->>'ptx'));
            -- The NOTICE reaches the client even when a driver drops the
            -- commit-time error (postgres-js does — see the test below), so
            -- the test can still see what the transaction contained when it died.
            RAISE NOTICE '%', msg;
            RAISE EXCEPTION '%', msg;
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER p5_fail_at_commit AFTER INSERT ON outbox_events
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION p5_fail_at_commit();
      `);
    });
    afterAll(async () => {
      await main.client.unsafe(`DROP TRIGGER IF EXISTS p5_fail_at_commit ON outbox_events; UPDATE p5_commit_fault SET armed = false;`);
    });

    it('failure AT COMMIT (deferred constraint trigger, after all three writes ran): NONE of events row, outbox row, transaction status persists; the caller is TOLD it failed even though the driver drops the commit error (NEGATIVE CONTROL); the retry then applies all three exactly once', async () => {
      const [{ deferred }] = await main.client`
        SELECT (tgdeferrable AND tginitdeferred) AS deferred FROM pg_trigger WHERE tgname = 'p5_fail_at_commit'`;
      expect(deferred).toBe(true);

      const ptx = 'ch_p5_commit';
      const txId = await seedTx(ptx, 'success');
      const key = 'webhook:p5-commit:payment_webhook';
      const effects = refundEffects(key, ptx);
      (effects.outbox.payload as Record<string, unknown>).ptx = ptx;

      // A writer whose server NOTICEs we capture (the trigger NOTICEs what
      // the transaction contained right before it raises at COMMIT).
      const notices: string[] = [];
      const writerClient = postgres(main.url, { max: 1, onnotice: (n) => notices.push(String(n.message)) });
      clients.push(writerClient);
      const writerDb = drizzle(writerClient);
      const writerRepo = createWebhookEventRepository(() => writerDb as never);

      await main.client`UPDATE p5_commit_fault SET armed = true`;
      try {
        // NEGATIVE CONTROL — the driver itself: postgres-js resolves an
        // extended-protocol statement on CommandComplete, before the
        // implicit COMMIT's ErrorResponse arrives, and then drops that
        // error. A plain single-statement write "succeeds" with nothing
        // persisted. This is why persistEffectsOnce confirms its commit.
        const lied = await writerClient`
          INSERT INTO outbox_events (app_id, event_type, payload)
          VALUES ('app_p5', 'p5_control', ${JSON.stringify({ id: 'p5-control' })}::jsonb) RETURNING id`;
        expect(lied).toHaveLength(1); // reported as written...
        expect(notices.some((n) => n.startsWith('p5 simulated failure at COMMIT'))).toBe(true); // ...the commit raised...
        expect(await main.client`SELECT id FROM outbox_events WHERE id = ${lied[0].id as string}`).toHaveLength(0); // ...and it is not there.
        notices.length = 0;

        let err: unknown;
        try {
          await writerRepo.persistEffectsOnce(effects);
        } catch (e) {
          err = e;
        }
        // The caller is told: no false success.
        expect(err).toBeDefined();
        expect(pgMessage(err)).toMatch(/not committed \(commit-time failure\)/);
        // The trigger ran at commit and saw the statement's own writes: the
        // outbox row, the events row (1) and the refunded status all existed
        // inside the transaction...
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatch(/^p5 simulated failure at COMMIT: outbox row [0-9a-f-]+ written, events rows for key=1, transaction status=refunded$/);
        // ...and all of it rolled back together.
        expect(await snapshot(key, txId)).toEqual({ events: 0, outbox: 0, txStatus: 'success' });
      } finally {
        await main.client`UPDATE p5_commit_fault SET armed = false`;
      }

      const ok = await writerRepo.persistEffectsOnce(effects);
      expect(ok.inserted).toBe(true);
      expect(ok.transactionUpdated).toBe(true);
      expect(await snapshot(key, txId)).toEqual({ events: 1, outbox: 1, txStatus: 'refunded' });

      const again = await webhookRepo.persistEffectsOnce(effects);
      expect(again).toMatchObject({ inserted: false, transactionUpdated: false });
      expect(await snapshot(key, txId)).toEqual({ events: 1, outbox: 1, txStatus: 'refunded' });
    });

    it('writer connection KILLED mid-statement (pg_terminate_backend while it is blocked inside the write): no partial write; a retry applies everything once', async () => {
      const ptx = 'ch_p5_kill';
      const txId = await seedTx(ptx, 'success');
      const key = 'webhook:p5-kill:payment_webhook';

      const writer = connect(main.url, 1);
      const [{ pid }] = await writer.client`SELECT pg_backend_pid() AS pid`;
      const writerRepo = createWebhookEventRepository(() => writer.db as never);

      // Hold the transactions row so the statement blocks INSIDE itself, after
      // its events insert has run (upd_tx's EXISTS(ins_event) forces it first).
      const locker = connect(main.url, 1);
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holding = locker.client.begin(async (tx) => {
        await tx`SELECT id FROM transactions WHERE id = ${txId} FOR UPDATE`;
        locked();
        await released;
      });
      await isLocked;

      const inFlight = writerRepo.persistEffectsOnce(refundEffects(key, ptx)).then(
        () => 'committed',
        (e) => `failed: ${pgCode(e) ?? ''} ${pgMessage(e)}`,
      );
      await waitFor(async () => {
        const [r] = await main.client`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
        return r?.wait_event_type === 'Lock';
      }, 'writer blocked inside the statement');
      const [{ killed }] = await main.client`SELECT pg_terminate_backend(${pid}) AS killed`;
      expect(killed).toBe(true);
      const outcome = await inFlight;
      expect(outcome).toMatch(/^failed/);

      release();
      await holding;
      expect(await snapshot(key, txId)).toEqual({ events: 0, outbox: 0, txStatus: 'success' });

      const ok = await webhookRepo.persistEffectsOnce(refundEffects(key, ptx));
      expect(ok).toMatchObject({ inserted: true, transactionUpdated: true });
      expect(await snapshot(key, txId)).toEqual({ events: 1, outbox: 1, txStatus: 'refunded' });
    });

    it('a transition the state machine forbids (late "success" after "refunded") is refused inside the statement: event + outbox recorded, transaction untouched', async () => {
      const ptx = 'ch_p5_late';
      const txId = await seedTx(ptx, 'refunded');
      const key = 'webhook:p5-late:payment_webhook';
      const res = await webhookRepo.persistEffectsOnce({
        ...refundEffects(key, ptx),
        transactionStatus: { providerTransactionId: ptx, toStatus: 'success', allowedFrom: transactionStatusesAllowedInto('success') },
      });
      expect(res).toMatchObject({ inserted: true, transactionUpdated: false });
      expect(await snapshot(key, txId)).toEqual({ events: 1, outbox: 1, txStatus: 'refunded' });
    });

    it('end to end: the payment_webhook consumer applies charge.refunded atomically with its events/outbox rows (failing cleanly at commit, then retrying), and the outbox poller delivers the outbox row once', async () => {
      const SECRET = 'p5-webhook-secret';
      const prevSecret = process.env.WEBHOOK_HMAC_SECRET;
      process.env.WEBHOOK_HMAC_SECRET = SECRET;
      try {
        const ptx = 'ch_p5_e2e';
        const txId = await seedTx(ptx, 'success');
        const body = { id: 'evt_p5_e2e', type: 'charge.refunded', data: { object: { id: ptx } } };
        const rawBody = JSON.stringify(body);
        const job: Job = {
          id: 'job_p5_e2e',
          type: 'payment_webhook',
          payload: {
            provider: 'stripe',
            providerEventId: body.id,
            rawBody,
            signature: createHmac('sha256', SECRET).update(rawBody).digest('hex'),
            applicationId: 'app_p5',
            type: body.type,
            data: body.data,
          },
          attempts: 0,
          maxAttempts: 5,
          status: 'processing',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runAt: Date.now(),
        };
        const emitted: unknown[] = [];
        const deps = {
          eventBus: { emit: async (e: unknown) => void emitted.push(e) } as unknown as JobDeps['eventBus'],
          config: { ...createWorkerConfig(), webhookConsumerLeaseMs: 60_000 },
          webhookEvents: webhookRepo,
        } as unknown as JobDeps;
        const processor = createPaymentWebhookProcessor(deps);
        const ctx = {} as Parameters<typeof processor>[1];

        // Attempt 1: the DB fails at commit → the job fails, nothing persisted.
        // (Without persistEffectsOnce's commit confirmation this attempt
        // RESOLVES on postgres-js — the job would be marked processed with
        // nothing persisted.)
        await main.client`UPDATE p5_commit_fault SET armed = true`;
        try {
          await expect(processor(job, ctx)).rejects.toThrow(/database write failed/);
        } finally {
          await main.client`UPDATE p5_commit_fault SET armed = false`;
        }
        // The consumer row records the failure (retryable), not 'processed'.
        const [cons] = await main.client`
          SELECT c.status FROM webhook_event_consumers c JOIN webhook_events w ON w.id = c.webhook_event_id
          WHERE w.provider_event_id = 'evt_p5_e2e' AND c.consumer = 'payment_webhook'`;
        expect(cons.status).toBe('failed');
        const [{ ob0 }] = await main.client`SELECT count(*)::int AS ob0 FROM outbox_events WHERE event_type = 'payment_webhook_received' AND payload->>'id' = 'evt_p5_e2e'`;
        expect(ob0).toBe(0);
        expect((await main.client`SELECT status FROM transactions WHERE id = ${txId}`)[0].status).toBe('success');
        expect(emitted).toHaveLength(0);

        // Attempt 2 (the queue's retry): everything lands together.
        await processor(job, ctx);
        expect((await main.client`SELECT status FROM transactions WHERE id = ${txId}`)[0].status).toBe('refunded');
        const obRows = await main.client`SELECT id FROM outbox_events WHERE event_type = 'payment_webhook_received' AND payload->>'id' = 'evt_p5_e2e'`;
        expect(obRows).toHaveLength(1);

        // A replayed job is a no-op (consumer already processed).
        await processor(job, ctx);
        expect(await main.client`SELECT id FROM outbox_events WHERE payload->>'id' = 'evt_p5_e2e'`).toHaveLength(1);

        // The outbox consumer picks the row up and dispatches it once.
        const rec = recorder();
        while ((await runOutboxPollOnce(repo, rec.dispatch)).claimed > 0);
        expect(rec.seen.filter((id) => id === obRows[0].id)).toHaveLength(1);
        expect((await row(obRows[0].id as string)).status).toBe('completed');
      } finally {
        if (prevSecret === undefined) delete process.env.WEBHOOK_HMAC_SECRET;
        else process.env.WEBHOOK_HMAC_SECRET = prevSecret;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Redis failure — the default dispatcher must not "complete" an event that
  // was never published (EventBus.emit() swallows publish errors).
  // -------------------------------------------------------------------------
  describe.skipIf(!redisServerBinaryAvailable || Boolean(process.env.TEST_REDIS_URL))('Redis outage during outbox dispatch (real redis-server, killed and restarted)', () => {
    let redis: TestRedis | undefined;
    let sub: Redis | undefined;
    let bus: EventBus;
    const prevRedisUrl = process.env.REDIS_URL;

    afterAll(async () => {
      sub?.disconnect();
      const internals = bus as unknown as { redisClient?: Redis; subClient?: Redis };
      internals?.redisClient?.disconnect();
      internals?.subClient?.disconnect();
      await redis?.stop();
      if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prevRedisUrl;
    });

    it('Redis up → published (event id = outbox id); Redis down → row NOT completed (retried, while plain emit() would have silently "succeeded"); Redis back → delivered exactly once', async () => {
      await main.client`TRUNCATE outbox_events`;
      const port = await freePort();
      redis = await startTestRedis({ port });
      process.env.REDIS_URL = redis.url;
      bus = EventBus.getInstance();
      const received: string[] = [];
      sub = new Redis(redis.url, { retryStrategy: () => 100, maxRetriesPerRequest: null });
      sub.on('error', () => undefined);
      sub.on('message', (_ch, msg) => received.push(JSON.parse(msg).id));
      await sub.subscribe('bis:events');

      const dispatch = eventBusOutboxDispatcher(bus);
      const cfg = { baseDelayMs: 50, maxDelayMs: 50, maxAttempts: 1_000 };

      // Up.
      const [id1] = await insertPending(1);
      await waitFor(async () => {
        await runOutboxPollOnce(repo, dispatch, cfg);
        return (await row(id1)).status === 'completed';
      }, 'first event published');
      await waitFor(() => received.includes(id1), 'subscriber saw first event');

      // Down.
      await redis.stop();
      await sleep(200);
      const [id2] = await insertPending(1);
      const down = await runOutboxPollOnce(repo, dispatch, cfg);
      expect(down.completed).toBe(0);
      expect(down.retried).toBe(1);
      const r2 = await row(id2);
      expect(r2.status).toBe('pending');
      expect(r2.error).toMatch(/EventBusPublishError/);
      // Negative control: the old outbox path used emit(), which resolves even now.
      await expect(bus.emit({ id: 'control', appId: 'x' } as never)).resolves.toBeUndefined();

      // Back up on the same port; the bus and the subscriber reconnect.
      redis = await startTestRedis({ port });
      await waitFor(async () => {
        await runOutboxPollOnce(repo, dispatch, cfg);
        return (await row(id2)).status === 'completed';
      }, 'second event published after Redis restart', 30_000);
      await waitFor(() => received.includes(id2), 'subscriber saw second event', 10_000);
      await sleep(200);
      expect(received.filter((x) => x === id2)).toHaveLength(1);
      expect(received.filter((x) => x === id1)).toHaveLength(1);
      expect(received).not.toContain('control');
    }, 60_000);
  });
});
