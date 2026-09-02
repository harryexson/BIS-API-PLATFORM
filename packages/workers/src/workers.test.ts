import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from './client';
import { createKeys } from './keys';
import { createWorkerConfig, Job, JobType } from './types';
import { computeBackoff } from './backoff';
import { DistributedLock } from './lock';
import { RateLimiter } from './rateLimit';
import { IdempotencyStore } from './idempotency';
import { JobQueue } from './queue';
import { WorkerManager } from './worker';

function makeContext() {
  const store = new MemoryStore();
  const keys = createKeys('test');
  const config = createWorkerConfig();
  config.concurrency = 1;
  return { store, keys, config };
}

function waitUntil(fn: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      if (await fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitUntil timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('computeBackoff', () => {
  it('grows exponentially and respects the ceiling', () => {
    const cfg = { baseDelayMs: 1000, maxDelayMs: 5000, factor: 2, maxDeadRetries: 3, maxAttempts: 5 };
    expect(computeBackoff(1, cfg)).toBeGreaterThanOrEqual(1000);
    expect(computeBackoff(2, cfg)).toBeGreaterThanOrEqual(2000);
    expect(computeBackoff(20, cfg)).toBeLessThanOrEqual(5000);
  });
});

describe('DistributedLock', () => {
  it('acquires and releases', async () => {
    const { store, keys } = makeContext();
    const lock = new DistributedLock(store, keys);
    const owner = 'o1';
    expect(await lock.acquire('res', owner, 5000)).toBe(true);
    expect(await lock.acquire('res', 'other', 5000)).toBe(false);
    expect(await lock.release('res', owner)).toBe(true);
    expect(await lock.acquire('res', 'other', 5000)).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then blocks', async () => {
    const { store, keys, config } = makeContext();
    config.rateLimit = { windowMs: 1000, maxRequests: 2 };
    const limiter = new RateLimiter(store, keys, config.rateLimit);
    expect((await limiter.limit('scope')).allowed).toBe(true);
    expect((await limiter.limit('scope')).allowed).toBe(true);
    const third = await limiter.limit('scope');
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });
});

describe('IdempotencyStore', () => {
  it('claims once and reports completion', async () => {
    const { store, keys, config } = makeContext();
    const idem = new IdempotencyStore(store, keys, config.idempotencyTtlMs);
    expect(await idem.claim('k1')).toBe('new');
    expect(await idem.claim('k1')).toBe('processing');
    await idem.complete('k1', { ok: true });
    expect(await idem.claim('k1')).toBe('completed');
    await idem.release('k1');
    expect(await idem.claim('k1')).toBe('new');
  });
});

describe('JobQueue', () => {
  it('enqueues, dequeues and completes', async () => {
    const { store, keys, config } = makeContext();
    const queue = new JobQueue(store, keys, config);
    const job = await queue.enqueue('event_processing', { a: 1 });
    const got = await queue.dequeue('event_processing');
    expect(got?.id).toBe(job.id);
    await queue.complete(got!);
    expect((await queue.getJob(job.id))!.status).toBe('completed');
  });

  it('schedules delayed jobs and promotes them', async () => {
    const { store, keys, config } = makeContext();
    const queue = new JobQueue(store, keys, config);
    await queue.enqueue('event_processing', { a: 1 }, { delayMs: 50 });
    expect(await queue.dequeue('event_processing')).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    const got = await queue.dequeue('event_processing');
    expect(got).not.toBeNull();
  });

  it('retries with backoff then dead-letters', async () => {
    const { store, keys, config } = makeContext();
    config.retry.maxAttempts = 2;
    const queue = new JobQueue(store, keys, config);
    const job = await queue.enqueue('event_processing', { a: 1 }, { maxAttempts: 2 });
    let cur = job;
    cur = await queue.fail(cur, 'boom1');
    expect(cur.attempts).toBe(1);
    expect(cur.status).toBe('pending');
    cur = await queue.fail(cur, 'boom2');
    expect(cur.status).toBe('dead');
    const dead = await queue.deadJobs('event_processing');
    expect(dead).toContain(cur.id);
  });
});

describe('WorkerManager', () => {
  it('processes jobs and supports idempotency', async () => {
    const { store, keys, config } = makeContext();
    const manager = new WorkerManager(store, keys, config);
    const queue = manager.getQueue();
    let calls = 0;
    manager.register('event_processing', async () => {
      calls++;
    });

    await manager.start();
    await queue.enqueue('event_processing', { x: 1 });
    await waitUntil(() => calls === 1);
    await manager.stop();
    expect(calls).toBe(1);
  });

  it('only processes a job once for a shared idempotency key', async () => {
    const { store, keys, config } = makeContext();
    const manager = new WorkerManager(store, keys, config);
    const queue = manager.getQueue();
    let calls = 0;
    manager.register('event_processing', async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
    });

    await manager.start();
    await queue.enqueue('event_processing', { x: 1 }, { idempotencyKey: 'same' });
    await queue.enqueue('event_processing', { x: 2 }, { idempotencyKey: 'same' });
    await waitUntil(() => calls === 1);
    await manager.stop();
    expect(calls).toBe(1);
  });

  it('retries failing jobs up to the limit then dead-letters', async () => {
    const { store, keys, config } = makeContext();
    config.retry = { baseDelayMs: 10, maxDelayMs: 50, factor: 2, maxAttempts: 2, maxDeadRetries: 1 };
    const manager = new WorkerManager(store, keys, config);
    const queue = manager.getQueue();
    manager.register('event_processing', async () => {
      throw new Error('always fails');
    });

    await manager.start();
    await queue.enqueue('event_processing', { x: 1 }, { maxAttempts: 2 });
    await waitUntil(async () => (await queue.deadCount('event_processing')) === 1, 4000);
    await manager.stop();
    expect(await queue.deadCount('event_processing')).toBe(1);
  });
});
