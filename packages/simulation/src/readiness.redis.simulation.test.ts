import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { clearDb, dbState, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, waitFor, type SimRuntime } from './harness';
import { EventBus } from '@company/events';
import { createStore, RedisStore, type KVStore } from '@company/workers';
import { freePort, redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';
import { createWorkerReadiness } from '../../../services/worker/src/readiness';

/**
 * Phase 19 (gap register B13/C6, PHASE14-01 residual) — /ready against a
 * REAL, spawned redis-server that is stopped and restarted on the same port
 * mid-test:
 *   connected        → 200, every Redis-backed component reported as such
 *   Redis stops      → components reported down at once, still 200 inside
 *                      the grace period (a blip must not drain the fleet)
 *   outage persists  → 503 naming exactly those components
 *   Redis returns    → 200 again, with no restart of the instance
 * for both the real gateway (in-process) and the worker's readiness check
 * (real RedisStore + the real EventBus singleton).
 */

const GRACE_MS = 3_000;
const ENV_KEYS = ['REDIS_URL', 'READINESS_GRACE_MS', 'ADMIN_API_TOKEN', 'PORTAL_JWT_SECRET', 'SECRET_ENCRYPTION_KEY'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const REDIS_COMPONENTS = ['queue', 'rateLimiter', 'eventBus'];

describe.skipIf(!redisAvailable)('readiness on a real Redis that goes away and comes back', () => {
  let redis: TestRedis;
  let port: number;
  let runtime: SimRuntime;
  let workerStore: KVStore;
  let workerReady: ReturnType<typeof createWorkerReadiness>;

  const gatewayReady = async () => {
    const res = await runtime.get('/ready');
    return { status: res.status, body: await res.json() };
  };
  const rateLimiterInfo = async () => {
    const { AuthService } = await import('../../../services/api-gateway/src/auth');
    return new AuthService().getRateLimiterInfo();
  };

  beforeAll(async () => {
    port = await freePort();
    redis = await startTestRedis({ port });
    clearDb();
    seedReachChurch();
    runtime = await createSimulation({
      env: {
        REDIS_URL: redis.url,
        READINESS_GRACE_MS: String(GRACE_MS),
        ADMIN_API_TOKEN: 'p19r-admin-token',
        PORTAL_JWT_SECRET: 'p19r-portal-jwt-secret',
        SECRET_ENCRYPTION_KEY: 'p19r-secret-encryption-key-0123456789',
      },
    });
    workerStore = await createStore(redis.url, { warn: () => undefined });
    workerReady = createWorkerReadiness({
      manager: { isRunning: () => true },
      store: workerStore,
      redisUrl: redis.url,
      providerState: () => ({ loaded: true, secretFailures: [] }),
      eventBus: EventBus.getInstance(),
      checkDatabase: async () => ({ status: 'healthy' }),
    });
  }, 30_000);

  afterAll(async () => {
    await workerStore?.quit?.();
    await runtime?.close();
    await redis?.stop();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }, 15_000);

  it('connected: ready, every Redis-backed component reported as actually connected', async () => {
    expect(runtime.gatewayStore).toBeInstanceOf(RedisStore);
    expect(workerStore).toBeInstanceOf(RedisStore);
    await waitFor(async () => (await gatewayReady()).status === 200, { label: 'gateway ready', timeoutMs: 10_000 });

    const { body } = await gatewayReady();
    expect(body).toMatchObject({
      status: 'ready',
      failing: [],
      degraded: [],
      dependencies: {
        database: 'healthy', rateLimiter: 'redis', providers: 'ready',
        queue: 'redis', eventBus: 'connected', secrets: 'configured',
      },
    });
    expect(await rateLimiterInfo()).toMatchObject({ type: 'redis', storeBacked: true, connection: 'ready' });

    const worker = await workerReady();
    expect(worker.httpStatus).toBe(200);
    expect(worker.body.dependencies).toMatchObject({ queue: 'redis', eventBus: 'connected', running: 'running' });
  });

  it("PHASE19-01: a slow but reachable database keeps the gateway ready (grade reported as 'degraded')", async () => {
    dbState.simulatedDbHealth = 'degraded';
    try {
      const { status, body } = await gatewayReady();
      expect(status).toBe(200);
      expect(body.dependencies.database).toBe('degraded');
      // Counted as UP — not merely a down dependency still inside the grace period.
      expect(body.degraded).toEqual([]);
    } finally {
      dbState.simulatedDbHealth = undefined;
    }
  });

  it('Redis outage: reported at once, still ready inside the grace period, NOT ready once it persists, ready again on recovery', async () => {
    await redis.stop();
    const stoppedAt = Date.now();

    // Reported immediately — not silently claimed healthy.
    await waitFor(
      async () => {
        const { body } = await gatewayReady();
        return REDIS_COMPONENTS.every((c) => body.degraded.includes(c) || body.failing.includes(c));
      },
      { label: 'gateway reports the Redis components down', timeoutMs: 2_000, everyMs: 20 },
    );
    const blip = await gatewayReady();
    expect(Date.now() - stoppedAt).toBeLessThan(GRACE_MS);
    expect(blip.status).toBe(200);
    expect(blip.body.degraded).toEqual(expect.arrayContaining(REDIS_COMPONENTS));
    expect(blip.body.dependencies).toMatchObject({
      queue: 'redis-disconnected', rateLimiter: 'redis-disconnected', eventBus: 'disconnected',
    });
    // PHASE14-01 residual: the limiter no longer claims to be store-backed
    // while every consume() is falling through to the per-replica insurance limiter.
    expect((await rateLimiterInfo()).storeBacked).toBe(false);

    const workerBlip = await workerReady();
    expect(workerBlip.httpStatus).toBe(200);
    expect(workerBlip.body.degraded).toEqual(expect.arrayContaining(['queue', 'eventBus']));

    // Sustained: past the grace period → 503 naming exactly the Redis components.
    await waitFor(async () => (await gatewayReady()).status === 503, { label: 'gateway not ready', timeoutMs: GRACE_MS + 3_000 });
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(GRACE_MS);
    const sustained = await gatewayReady();
    expect(sustained.body.status).toBe('degraded');
    expect([...sustained.body.failing].sort()).toEqual([...REDIS_COMPONENTS].sort());
    // Each gate's grace window starts at ITS first observation of the outage
    // (the worker's was `workerBlip` above, a little after the gateway's).
    await waitFor(async () => (await workerReady()).httpStatus === 503, { label: 'worker not ready', timeoutMs: GRACE_MS + 3_000 });
    const workerSustained = await workerReady();
    expect(workerSustained.httpStatus).toBe(503);
    expect([...workerSustained.body.failing].sort()).toEqual(['eventBus', 'queue']);

    // Recovery: same port, the clients reconnect by themselves.
    redis = await startTestRedis({ port });
    await waitFor(async () => (await gatewayReady()).status === 200, { label: 'gateway ready again', timeoutMs: 30_000, everyMs: 100 });
    await waitFor(async () => (await workerReady()).httpStatus === 200, { label: 'worker ready again', timeoutMs: 30_000, everyMs: 100 });
    expect((await gatewayReady()).body.dependencies).toMatchObject({ queue: 'redis', rateLimiter: 'redis', eventBus: 'connected' });
    expect((await rateLimiterInfo()).storeBacked).toBe(true);
  }, 60_000);
});
