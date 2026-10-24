import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store.memory';
import { RedisStore } from './store.redis';
import type { KVStore } from './store';
import { createKeys } from './keys';
import { createWorkerConfig, type Job, type JobType, type WorkerConfig } from './types';
import { JobQueue } from './queue';
import { WorkerManager } from './worker';
import { IdempotencyStore } from './idempotency';
import { DistributedLock } from './lock';
import { createProviderHealthProcessor } from './jobs/providerHealth';
import { createReconciliationProcessor } from './jobs/reconciliation';
import type { JobDeps } from './jobs/deps';
import { redisAvailable, startTestRedis, type TestRedis } from './test-utils/redis-server';

/**
 * Phase 13 — worker reliability (gap register B6, B7, B15).
 *
 * Every scenario runs twice: against MemoryStore, and against a REAL
 * redis-server (spawned on a free port, or TEST_REDIS_URL) where each
 * simulated worker/process gets its OWN connection, so "concurrent" really
 * means separate clients racing on the server.
 */

interface Backend {
  name: string;
  enabled: boolean;
  /** `n` store handles over the SAME underlying data (same instance for memory, separate connections for Redis). */
  stores(n: number): Promise<KVStore[]>;
}

let redis: TestRedis | undefined;
const opened: KVStore[] = [];

const memoryBackend: Backend = {
  name: 'MemoryStore',
  enabled: true,
  async stores(n) {
    const s = new MemoryStore();
    return Array.from({ length: n }, () => s);
  },
};

const redisBackend: Backend = {
  name: 'real Redis',
  enabled: redisAvailable,
  async stores(n) {
    const out: KVStore[] = [];
    for (let i = 0; i < n; i++) {
      const s = new RedisStore(redis!.url);
      opened.push(s);
      await s.waitUntilReady(5_000);
      out.push(s);
    }
    return out;
  },
};

beforeAll(async () => {
  if (redisAvailable) redis = await startTestRedis();
}, 20_000);

afterAll(async () => {
  for (const s of opened) await s.quit?.();
  await redis?.stop();
});

function cfg(): WorkerConfig {
  const c = createWorkerConfig();
  c.concurrency = 1;
  c.pollIntervalMs = 10;
  return c;
}

function waitUntil(fn: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        if (await fn()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - start > timeout) return reject(new Error('waitUntil timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ageJob(store: KVStore, keys: ReturnType<typeof createKeys>, id: string, c: WorkerConfig, byMs: number) {
  const job = JSON.parse((await store.get(keys.job(id)))!) as Job;
  job.updatedAt = Date.now() - byMs;
  await store.set(keys.job(id), JSON.stringify(job), c.idempotencyTtlMs);
}

for (const backend of [memoryBackend, redisBackend]) {
  // ───────────────────────────── B7 ─────────────────────────────
  describe.skipIf(!backend.enabled)(`B7 — promoteDelayed() never promotes the same job twice (${backend.name})`, () => {
    it('five concurrent promoters over the same due jobs push each id onto the ready list exactly once', async () => {
      const keys = createKeys(`p13b7-${randomUUID()}`);
      const c = cfg();
      const stores = await backend.stores(5);
      const queues = stores.map((s) => new JobQueue(s, keys, c));
      const type: JobType = 'message_delivery';

      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push((await queues[0].enqueue(type, { i }, { delayMs: 20 })).id);
      await sleep(40);

      const promotedCounts = await Promise.all(queues.map((q) => q.promoteDelayed(type)));

      const ready = await stores[0].lrange(keys.ready(type), 0, -1);
      expect(ready.length).toBe(20);
      expect(new Set(ready).size).toBe(20);
      expect([...ready].sort()).toEqual([...ids].sort());
      expect(promotedCounts.reduce((a, b) => a + b, 0)).toBe(20);
      expect(await queues[0].delayedCount(type)).toBe(0);
    });

    it('end to end: a job that fails once is run exactly twice (fail + retry) by two managers with 5 loops each', async () => {
      const keys = createKeys(`p13b7e2e-${randomUUID()}`);
      const c = cfg();
      c.concurrency = 5;
      c.retry = { ...c.retry, baseDelayMs: 30, maxDelayMs: 30, factor: 1 };
      const [s1, s2] = await backend.stores(2);
      const runs: string[] = [];
      let failedOnce = false;
      const proc = async (job: Job) => {
        runs.push(job.id);
        if (!failedOnce) {
          failedOnce = true;
          throw new Error('transient');
        }
        await sleep(50); // keep the retry "in flight" while other loops poll
      };
      const m1 = new WorkerManager(s1, keys, c).register('message_delivery', proc);
      const m2 = new WorkerManager(s2, keys, c).register('message_delivery', proc);
      await m1.start();
      await m2.start();
      const job = await m1.getQueue().enqueue('message_delivery', { to: '+15550000001' });
      await waitUntil(async () => (await m1.getQueue().getJob(job.id))?.status === 'completed');
      await sleep(150); // give any duplicate promotion time to be picked up
      await m1.stop();
      await m2.stop();
      expect(runs).toEqual([job.id, job.id]);
    });
  });

  // ───────────────────────────── B6 ─────────────────────────────
  describe.skipIf(!backend.enabled)(`B6 — a rescued job whose crashed attempt left its idempotency claim actually runs (${backend.name})`, () => {
    it('worker A crashes mid-job holding the claim; replacement worker B rescues the job and RUNS it exactly once', async () => {
      const keys = createKeys(`p13b6-${randomUUID()}`);
      const c = cfg();
      const [storeA, storeB] = await backend.stores(2);
      const type: JobType = 'keyword_response_delivery';
      const idemKey = `keyword_reply:inbound-${randomUUID()}`;

      // Worker A picks the job up and "crashes": its processor never returns.
      let releaseA!: () => void;
      const hang = new Promise<void>((r) => (releaseA = r));
      let aRuns = 0;
      const a = new WorkerManager(storeA, keys, c).register(type, async () => {
        aRuns++;
        await hang;
      });
      await a.start();
      const job = await a.getQueue().enqueue(type, { senderPhone: '+15550000002', content: 'reply' }, { idempotencyKey: idemKey });
      await waitUntil(() => aRuns === 1);
      const held = await a.getIdempotency().get(idemKey);
      expect(held?.status).toBe('processing');

      // Time passes beyond the reaper threshold with A dead.
      await ageJob(storeB, keys, job.id, c, 10 * 60_000);

      // Replacement worker B starts — its startup reaper rescues the job.
      let bRuns = 0;
      const b = new WorkerManager(storeB, keys, c).register(type, async () => {
        bRuns++;
      });
      await b.start();
      await waitUntil(async () => (await b.getQueue().getJob(job.id))?.status === 'completed');
      await b.stop();

      expect(bRuns).toBe(1);
      const rec = await b.getIdempotency().get(idemKey);
      expect(rec?.status).toBe('completed');
      expect(rec?.result).toEqual({ id: job.id });

      const stopping = a.stop();
      releaseA();
      await stopping;
    });

    it('scope guard: rescuing job Y does NOT release a claim on the same key held by a different job X', async () => {
      const keys = createKeys(`p13b6scope-${randomUUID()}`);
      const c = cfg();
      const [store] = await backend.stores(1);
      const idem = new IdempotencyStore(store, keys, c.idempotencyTtlMs);
      const queue = new JobQueue(store, keys, c);
      const idemKey = `k-${randomUUID()}`;

      expect(await idem.claim(idemKey, 'job_X')).toBe('new');
      const y = await queue.enqueue('event_processing', {}, { idempotencyKey: idemKey });
      const dq = await queue.dequeue('event_processing');
      expect(dq?.id).toBe(y.id);
      await ageJob(store, keys, y.id, c, 10 * 60_000);

      expect(await queue.rescueStuckJobs(60_000)).toBe(1);
      const rec = await idem.get(idemKey);
      expect(rec?.status).toBe('processing');
      expect(rec?.ownerJobId).toBe('job_X');
      expect(await idem.claim(idemKey, y.id)).toBe('processing');
    });

    it('scope guard: a job that crashed AFTER its claim was marked completed is not re-run on rescue', async () => {
      const keys = createKeys(`p13b6done-${randomUUID()}`);
      const c = cfg();
      const [store] = await backend.stores(1);
      const idemKey = `k-${randomUUID()}`;
      const m = new WorkerManager(store, keys, c);
      let runs = 0;
      m.register('event_processing', async () => {
        runs++;
      });
      const queue = m.getQueue();
      const job = await queue.enqueue('event_processing', {}, { idempotencyKey: idemKey });
      // Simulate: dequeued, claimed, processed, claim completed — crash before queue.complete().
      await queue.dequeue('event_processing');
      await m.getIdempotency().claim(idemKey, job.id);
      await m.getIdempotency().complete(idemKey, { id: job.id });
      await ageJob(store, keys, job.id, c, 10 * 60_000);

      await m.start(); // startup reaper rescues it
      await waitUntil(async () => (await queue.getJob(job.id))?.status === 'completed');
      await m.stop();
      expect(runs).toBe(0);
    });
  });

  // ───────────────────────────── B15 ─────────────────────────────
  describe.skipIf(!backend.enabled)(`B15 — lock contention waits (bounded) or skips instead of throwing (${backend.name})`, () => {
    it('withLock waits for a holder that releases within the bound, then runs', async () => {
      const keys = createKeys(`p13b15-${randomUUID()}`);
      const [s1, s2] = await backend.stores(2);
      const holder = new DistributedLock(s1, keys);
      const waiter = new DistributedLock(s2, keys);
      expect(await holder.acquire('provider:p1', 'health_holder', 10_000)).toBe(true);
      setTimeout(() => void holder.release('provider:p1', 'health_holder'), 150);

      const started = Date.now();
      const result = await waiter.withLock('provider:p1', 'webhook_waiter', 10_000, async () => 'ran');
      expect(result).toBe('ran');
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      // and it released afterwards
      expect(await holder.acquire('provider:p1', 'someone_else', 1_000)).toBe(true);
    });

    it('withLock gives up after the bound with LockNotAcquiredError, without running fn', async () => {
      const keys = createKeys(`p13b15b-${randomUUID()}`);
      const [s1, s2] = await backend.stores(2);
      await new DistributedLock(s1, keys).acquire('provider:p1', 'holder', 10_000);
      const fn = vi.fn(async () => 'ran');
      const started = Date.now();
      const err = await new DistributedLock(s2, keys)
        .withLock('provider:p1', 'waiter', 10_000, fn, { waitMs: 200 })
        .then(() => null, (e: unknown) => e as Error);
      const elapsed = Date.now() - started;
      expect(err?.name).toBe('LockNotAcquiredError');
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(2_000);
      expect(fn).not.toHaveBeenCalled();
    });

    it('tryWithLock reports { acquired: false } on contention and never throws', async () => {
      const keys = createKeys(`p13b15c-${randomUUID()}`);
      const [s1, s2] = await backend.stores(2);
      await new DistributedLock(s1, keys).acquire('reconciliation', 'holder', 10_000);
      const fn = vi.fn(async () => 'ran');
      const outcome = await new DistributedLock(s2, keys).tryWithLock('reconciliation', 'other', 10_000, fn);
      expect(outcome).toEqual({ acquired: false });
      expect(fn).not.toHaveBeenCalled();
    });

    it('a provider_health JOB under lock contention completes (skips) instead of failing into retry/dead-letter', async () => {
      const keys = createKeys(`p13b15job-${randomUUID()}`);
      const c = cfg();
      const [s1, s2] = await backend.stores(2);
      // Another replica's health check holds the provider lock for the whole test.
      await new DistributedLock(s1, keys).acquire('provider:p1', 'other_replica', 60_000);
      const runHealthCheck = vi.fn();
      const deps = {
        registry: { getAllConfigs: () => [{ id: 'p1' }], runHealthCheck, updateManagement: vi.fn() },
        lock: new DistributedLock(s2, keys),
        config: c,
      } as unknown as JobDeps;
      const m = new WorkerManager(s2, keys, c).register('provider_health', createProviderHealthProcessor(deps));
      await m.start();
      const job = await m.getQueue().enqueue('provider_health', { providerId: 'p1' });
      await waitUntil(async () => {
        const j = await m.getQueue().getJob(job.id);
        return j?.status === 'completed' || (j?.attempts ?? 0) > 0;
      });
      await m.stop();
      const final = await m.getQueue().getJob(job.id);
      expect(final?.lastError).toBeUndefined();
      expect(final?.attempts).toBe(0);
      expect(final?.status).toBe('completed');
      expect(runHealthCheck).not.toHaveBeenCalled();
    });

    it('the reconciliation job skips cleanly (no throw, no work) while another run holds its lock', async () => {
      const keys = createKeys(`p13b15recon-${randomUUID()}`);
      const c = cfg();
      const [s1, s2] = await backend.stores(2);
      await new DistributedLock(s1, keys).acquire('reconciliation', 'other_replica', 60_000);
      const emit = vi.fn();
      const deps = { lock: new DistributedLock(s2, keys), config: c, eventBus: { emit } } as unknown as JobDeps;
      const queue = { deadCount: vi.fn(async () => 0) } as unknown as JobQueue;
      await expect(
        createReconciliationProcessor(deps, queue)({ id: 'r1', type: 'reconciliation', payload: {} } as unknown as Job, {} as never),
      ).resolves.toBeUndefined();
      expect(emit).not.toHaveBeenCalled();
      expect(queue.deadCount).not.toHaveBeenCalled();
    });
  });
}
