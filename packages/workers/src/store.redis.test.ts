import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { createStore } from './client';
import { MemoryStore } from './store.memory';
import { RedisStore } from './store.redis';
import { JobQueue } from './queue';
import { createKeys } from './keys';
import { createWorkerConfig } from './types';
import type { KVStore } from './store';
import { freePort, redisAvailable, startTestRedis, type TestRedis } from './test-utils/redis-server';

/**
 * Gap register B1 — permanent regression test against a REAL redis-server
 * (spawned on a free port by the test itself, or TEST_REDIS_URL).
 *
 * The defect: RedisStore's constructor fired connect() without awaiting it,
 * and createStore() probed readiness synchronously right after, so it fell
 * back to MemoryStore on EVERY call — Redis up or down. The gateway and the
 * worker therefore each ran a private in-memory queue and gateway-enqueued
 * jobs never reached the worker. The Phase-0 audit reproduced this with a
 * throwaway script ("probe1"); this file makes it a permanent check.
 */
describe.skipIf(!redisAvailable)('B1 — createStore() uses Redis when Redis is reachable (real redis-server)', () => {
  let redis: TestRedis;
  const opened: KVStore[] = [];

  beforeAll(async () => {
    redis = await startTestRedis();
  }, 20_000);

  afterAll(async () => {
    for (const s of opened) await s.quit?.();
    await redis?.stop();
  });

  it('returns a working RedisStore — not a MemoryStore — when Redis answers', async () => {
    const warnings: string[] = [];
    const store = await createStore(redis.url, { warn: (m) => warnings.push(m) });
    opened.push(store);

    expect(store).toBeInstanceOf(RedisStore);
    expect(store).not.toBeInstanceOf(MemoryStore);
    expect(warnings).toEqual([]);
    expect((store as RedisStore).isConnected()).toBe(true);

    // Prove the data really lives in the redis-server, using an independent
    // raw client — a MemoryStore could never satisfy this.
    const key = `b1:probe:${Date.now()}`;
    await store.set(key, 'from-createStore', 60_000);
    const raw = new Redis(redis.url);
    try {
      expect(await raw.get(key)).toBe('from-createStore');
    } finally {
      raw.disconnect();
    }
  });

  it('two independent createStore() calls (gateway + worker) share one queue', async () => {
    // Two separate stores/connections, as in two separate processes.
    const gatewayStore = await createStore(redis.url);
    const workerStore = await createStore(redis.url);
    opened.push(gatewayStore, workerStore);
    expect(gatewayStore).toBeInstanceOf(RedisStore);
    expect(workerStore).toBeInstanceOf(RedisStore);

    const config = { ...createWorkerConfig(), maxQueueDepth: 0 };
    const keys = createKeys(`b1test-${Date.now()}`);
    const gatewayQueue = new JobQueue(gatewayStore, keys, config);
    const workerQueue = new JobQueue(workerStore, keys, config);

    const job = await gatewayQueue.enqueue('payment_webhook', { probe: 'cross-process' });
    const got = await workerQueue.dequeue('payment_webhook');
    expect(got?.id).toBe(job.id);
    expect(got?.payload).toEqual({ probe: 'cross-process' });
  });

  it('falls back to MemoryStore with a clear warning only when Redis is genuinely unreachable', async () => {
    const deadPort = await freePort(); // nothing listens here
    const warnings: string[] = [];
    const started = Date.now();
    const store = await createStore(`redis://127.0.0.1:${deadPort}`, {
      connectTimeoutMs: 3_000,
      warn: (m) => warnings.push(m),
    });
    opened.push(store);

    expect(store).toBeInstanceOf(MemoryStore);
    expect(Date.now() - started).toBeLessThan(3_000); // refused → immediate, not a timeout
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Redis unavailable');
    expect(warnings[0]).toContain(`127.0.0.1:${deadPort}`);
    expect(warnings[0]).toContain('falling back to in-memory store');
  });

  it('never logs Redis credentials in the fallback warning', async () => {
    const deadPort = await freePort();
    const warnings: string[] = [];
    const store = await createStore(`redis://user:s3cret-pw@127.0.0.1:${deadPort}`, {
      connectTimeoutMs: 3_000,
      warn: (m) => warnings.push(m),
    });
    opened.push(store);
    expect(store).toBeInstanceOf(MemoryStore);
    expect(warnings[0]).not.toContain('s3cret-pw');
  });

  it("an explicit 'memory' URL still yields a MemoryStore without any warning", async () => {
    const warnings: string[] = [];
    const store = await createStore('memory', { warn: (m) => warnings.push(m) });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(warnings).toEqual([]);
  });
});
