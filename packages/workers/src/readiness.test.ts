import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryStore } from './store.memory';
import { createStore } from './client';
import {
  ReadinessGate,
  readinessGraceMsFromEnv,
  probeQueueStore,
  probeDatabase,
  probeEventBus,
  probeProviderState,
  probeSecrets,
  missingSecrets,
  up,
  down,
  failed,
} from './readiness';
import { freePort, redisAvailable, startTestRedis, type TestRedis } from './test-utils/redis-server';

/**
 * Phase 19 (gap register B13/C6): the shared /ready model used by the
 * gateway and the worker. The HTTP endpoints themselves are covered by
 * packages/simulation/src/readiness*.test.ts.
 */

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('ReadinessGate', () => {
  it('a dependency that has never been up is not ready (no grace at startup)', () => {
    const c = clock();
    const gate = new ReadinessGate({ graceMs: 30_000, now: c.now });
    const r = gate.evaluate({ queue: down('redis-disconnected') });
    expect(r.ready).toBe(false);
    expect(r.failing).toEqual(['queue']);
    expect(r.dependencies).toEqual({ queue: 'redis-disconnected' });
  });

  it('a dependency that drops after being up is reported at once but only fails after the grace period', () => {
    const c = clock();
    const gate = new ReadinessGate({ graceMs: 30_000, now: c.now });
    expect(gate.evaluate({ queue: up('redis') }).ready).toBe(true);

    const blip = gate.evaluate({ queue: down('redis-disconnected') });
    expect(blip.ready).toBe(true);
    expect(blip.degraded).toEqual(['queue']);
    expect(blip.dependencies.queue).toBe('redis-disconnected');

    c.advance(29_999);
    expect(gate.evaluate({ queue: down('redis-disconnected') }).ready).toBe(true);
    c.advance(1);
    const sustained = gate.evaluate({ queue: down('redis-disconnected') });
    expect(sustained.ready).toBe(false);
    expect(sustained.failing).toEqual(['queue']);
    expect(sustained.degraded).toEqual([]);
  });

  it('recovery resets the grace window', () => {
    const c = clock();
    const gate = new ReadinessGate({ graceMs: 10_000, now: c.now });
    gate.evaluate({ db: up('healthy') });
    gate.evaluate({ db: down('unhealthy') });
    c.advance(9_000);
    expect(gate.evaluate({ db: up('healthy') }).ready).toBe(true);
    c.advance(1_000);
    // A new outage starts a NEW window rather than continuing the old one.
    expect(gate.evaluate({ db: down('unhealthy') }).ready).toBe(true);
    c.advance(9_999);
    expect(gate.evaluate({ db: down('unhealthy') }).ready).toBe(true);
    c.advance(1);
    expect(gate.evaluate({ db: down('unhealthy') }).ready).toBe(false);
  });

  it("'failed' is never given grace, even for a dependency that was up", () => {
    const c = clock();
    const gate = new ReadinessGate({ graceMs: 60_000, now: c.now });
    gate.evaluate({ secrets: up('configured') });
    expect(gate.evaluate({ secrets: failed('missing') }).failing).toEqual(['secrets']);
  });

  it('graceMs 0 fails a lost connection immediately', () => {
    const c = clock();
    const gate = new ReadinessGate({ graceMs: 0, now: c.now });
    gate.evaluate({ eventBus: up('connected') });
    expect(gate.evaluate({ eventBus: down('disconnected') }).ready).toBe(false);
  });

  it('READINESS_GRACE_MS overrides the 30s default; junk falls back to the default', () => {
    expect(readinessGraceMsFromEnv({})).toBe(30_000);
    expect(readinessGraceMsFromEnv({ READINESS_GRACE_MS: '0' })).toBe(0);
    expect(readinessGraceMsFromEnv({ READINESS_GRACE_MS: '5000' })).toBe(5_000);
    expect(readinessGraceMsFromEnv({ READINESS_GRACE_MS: 'abc' })).toBe(30_000);
    expect(readinessGraceMsFromEnv({ READINESS_GRACE_MS: '-1' })).toBe(30_000);
    expect(readinessGraceMsFromEnv({ READINESS_GRACE_MS: '' })).toBe(30_000);
  });
});

describe('readiness probes', () => {
  it('queue: a MemoryStore while Redis is configured is the silent B1 fallback — failed, not healthy', () => {
    const store = new MemoryStore();
    expect(probeQueueStore(store, 'redis://10.0.0.1:6379', false)).toEqual(failed('memory-fallback'));
    expect(probeQueueStore(store, 'redis://10.0.0.1:6379', true)).toEqual(failed('memory-fallback'));
    // Explicit single-process mode is accepted outside production only.
    expect(probeQueueStore(store, 'memory', false)).toEqual(up('memory'));
    expect(probeQueueStore(store, 'memory', true)).toEqual(failed('memory'));
    expect(probeQueueStore(store, '', false)).toEqual(up('memory'));
  });

  it("database: 'degraded' (reachable, slow) is up; 'unhealthy' or a throw is down", async () => {
    expect(await probeDatabase(async () => ({ status: 'healthy' }))).toEqual(up('healthy'));
    expect(await probeDatabase(async () => ({ status: 'degraded' }))).toEqual(up('degraded'));
    expect(await probeDatabase(async () => ({ status: 'unhealthy' }))).toEqual(down('unhealthy'));
    expect(
      await probeDatabase(async () => {
        throw new Error('DATABASE_URL not set');
      }),
    ).toEqual(down('unreachable'));
  });

  it('eventBus / providers / secrets', () => {
    expect(probeEventBus('connected')).toEqual(up('connected'));
    expect(probeEventBus('disconnected')).toEqual(down('disconnected'));
    expect(probeEventBus('not-configured')).toEqual(up('not-configured'));

    expect(probeProviderState({ loaded: false, secretFailures: [] })).toEqual(failed('not-loaded'));
    expect(probeProviderState({ loaded: true, secretFailures: [{}] })).toEqual(failed('degraded'));
    expect(probeProviderState({ loaded: true, secretFailures: [] })).toEqual(up('ready'));

    expect(missingSecrets(['A', 'B', 'C'], { A: 'x', B: '  ' })).toEqual(['B', 'C']);
    expect(probeSecrets([], true)).toEqual(up('configured'));
    expect(probeSecrets(['WEBHOOK_HMAC_SECRET'], true)).toEqual(failed('missing'));
    expect(probeSecrets(['WEBHOOK_HMAC_SECRET'], false)).toEqual(up('missing-non-production'));
  });

  it('queue: createStore() against an unreachable Redis returns the fallback the probe refuses', async () => {
    const url = `redis://127.0.0.1:${await freePort()}`;
    const store = await createStore(url, { connectTimeoutMs: 300, warn: () => undefined });
    expect(store).toBeInstanceOf(MemoryStore);
    expect(probeQueueStore(store, url, false)).toEqual(failed('memory-fallback'));
  });
});

describe.skipIf(!redisAvailable)('readiness probes on a real Redis', () => {
  let redis: TestRedis;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    redis = await startTestRedis({ port });
  });
  afterAll(async () => {
    await redis?.stop();
  });

  it('queue: a RedisStore is up while connected, down when Redis goes away, up again after it returns', async () => {
    const store = await createStore(redis.url, { warn: () => undefined });
    try {
      expect(probeQueueStore(store, redis.url, true)).toEqual(up('redis'));
      await redis.stop();
      const deadline = Date.now() + 10_000;
      while (probeQueueStore(store, redis.url, true).state === 'up' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(probeQueueStore(store, redis.url, true)).toEqual(down('redis-disconnected'));

      redis = await startTestRedis({ port });
      const back = Date.now() + 20_000;
      while (probeQueueStore(store, redis.url, true).state !== 'up' && Date.now() < back) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(probeQueueStore(store, redis.url, true)).toEqual(up('redis'));
    } finally {
      await store.quit?.();
    }
  }, 40_000);
});
