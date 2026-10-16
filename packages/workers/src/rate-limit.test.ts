import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store.memory';
import { RedisStore } from './store.redis';
import type { KVStore } from './store';
import { createKeys } from './keys';
import { RateLimiter } from './rateLimit';
import { redisAvailable, startTestRedis, type TestRedis } from './test-utils/redis-server';

/**
 * Phase 14 — gap register B14: the rate-limit window must be a FIXED window.
 *
 * `incr(key, ttlMs)` used to re-apply the full TTL on every call (and
 * `RateLimiter.limit` re-applied it again), so under steady traffic the key
 * never expired: once a scope hit `maxRequests` it stayed blocked for as long
 * as callers kept retrying, each blocked attempt pushing the window out again.
 *
 * Same dual-backend pattern as worker-reliability.test.ts: every scenario runs
 * against MemoryStore and against a REAL redis-server, where each simulated
 * process gets its OWN connection so concurrent increments really race on the
 * server.
 */

interface Backend {
  name: string;
  enabled: boolean;
  /** `n` store handles over the SAME underlying data. */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const backend of [memoryBackend, redisBackend]) {
  describe.skipIf(!backend.enabled)(`B14 — fixed-window rate limiting (${backend.name})`, () => {
    it('incr() sets the TTL only when it creates the key; later increments do not extend it', async () => {
      const [store] = await backend.stores(1);
      const key = `p14-incr-${randomUUID()}`;

      expect(await store.incr(key, 400)).toBe(1);
      const ttlAtCreate = await store.pttl(key);
      expect(ttlAtCreate).toBeGreaterThan(0);
      expect(ttlAtCreate).toBeLessThanOrEqual(400);

      await sleep(150);
      expect(await store.incr(key, 400)).toBe(2);
      const ttlAfterSecond = await store.pttl(key);
      // The window started at the first increment: ~250ms left, NOT reset to ~400ms.
      expect(ttlAfterSecond).toBeGreaterThan(0);
      expect(ttlAfterSecond).toBeLessThanOrEqual(400 - 100);

      await sleep(300);
      // Window over: the counter starts again from 1 with a fresh TTL.
      expect(await store.incr(key, 400)).toBe(1);
    });

    it('a counter left without any TTL (e.g. a crash mid-write) is given one, so it can never block forever', async () => {
      const [store] = await backend.stores(1);
      const key = `p14-nottl-${randomUUID()}`;
      await store.set(key, '7');
      expect(await store.pttl(key)).toBe(-1);

      expect(await store.incr(key, 300)).toBe(8);
      const ttl = await store.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('under continuous traffic a blocked scope is allowed again once its window elapses', async () => {
      const [store] = await backend.stores(1);
      const keys = createKeys(`p14-rl-${randomUUID()}`);
      const windowMs = 300;
      const limiter = new RateLimiter(store, keys, { windowMs, maxRequests: 3 });

      const start = Date.now();
      const log: { at: number; allowed: boolean; resetMs: number }[] = [];
      // One attempt every ~25ms for ~3.5 windows — a caller that never backs
      // off. With the defect every blocked attempt re-armed the full TTL, so
      // after the first 3 nothing was ever allowed again.
      while (Date.now() - start < windowMs * 3.5) {
        const r = await limiter.limit('steady');
        log.push({ at: Date.now() - start, allowed: r.allowed, resetMs: r.resetMs });
        await sleep(25);
      }

      const allowed = log.filter((e) => e.allowed);
      expect(log.slice(0, 3).every((e) => e.allowed)).toBe(true);
      expect(log[3].allowed).toBe(false);
      // Blocked inside the first window, allowed again in later windows.
      expect(allowed.some((e) => e.at >= windowMs)).toBe(true);
      // At most maxRequests per window: 3.5 windows => at most 4 windows touched.
      expect(allowed.length).toBeGreaterThanOrEqual(6);
      expect(allowed.length).toBeLessThanOrEqual(12);
      // The reported reset time never exceeds the window.
      for (const e of allowed) expect(e.resetMs).toBeLessThanOrEqual(windowMs);

      // And the key really does expire: a quiet period of one window clears it.
      await sleep(windowMs + 50);
      expect(await store.get(keys.rateLimit('steady'))).toBeNull();
    });

    it('concurrent increments from several processes count exactly and still share ONE expiring window', async () => {
      const stores = await backend.stores(5);
      const keys = createKeys(`p14-conc-${randomUUID()}`);
      const windowMs = 400;
      const limiters = stores.map((s) => new RateLimiter(s, keys, { windowMs, maxRequests: 20 }));

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => limiters[i % limiters.length].limit('burst')),
      );
      expect(results.filter((r) => r.allowed).length).toBe(20);
      expect(results.filter((r) => !r.allowed).length).toBe(30);
      expect(await stores[0].get(keys.rateLimit('burst'))).toBe('50');

      const ttl = await stores[0].pttl(keys.rateLimit('burst'));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(windowMs);

      // Keep hammering with blocked attempts from every process; the window
      // must still close on schedule (it used to be pushed out by each one).
      const until = Date.now() + windowMs + 150;
      let sawAllowedAgain = false;
      while (Date.now() < until) {
        const round = await Promise.all(limiters.map((l) => l.limit('burst')));
        if (round.some((r) => r.allowed)) sawAllowedAgain = true;
        await sleep(20);
      }
      expect(sawAllowedAgain).toBe(true);
    });
  });
}
