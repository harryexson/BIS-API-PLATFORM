import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { clearDb, dbState, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import { MemoryStore, ReadinessGate, WorkerManager, createKeys, createStore } from '@company/workers';
import { freePort } from '../../workers/src/test-utils/redis-server';
import { createWorkerReadiness } from '../../../services/worker/src/readiness';
import { DEFAULT_WORKER_CONFIG } from './harness';

/**
 * Phase 19 (gap register B13/C6) — /ready on the REAL gateway (in-process,
 * simulated database) when Redis is CONFIGURED but cannot be reached: the
 * exact situation in which the gateway's job queue silently falls back to a
 * per-process MemoryStore (B1) and its rate limiter to a per-replica
 * in-memory insurance limiter. Before Phase 19 this instance answered 200
 * "ready" (rate limiter reported 'redis'; queue, EventBus and secrets were
 * never looked at). The same for the worker's /ready (services/worker).
 *
 * The real-Redis half (connect → outage → grace → 503 → recovery) is in
 * readiness.redis.simulation.test.ts; a genuinely separate worker OS
 * process in worker-readiness.process.test.ts.
 */

const SECRET_KEYS = ['ADMIN_API_TOKEN', 'PORTAL_JWT_SECRET', 'SECRET_ENCRYPTION_KEY'] as const;
const ENV_KEYS = ['REDIS_URL', 'REDIS_CONNECT_TIMEOUT_MS', 'NODE_ENV', 'WEBHOOK_HMAC_SECRET', ...SECRET_KEYS];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};

async function ready(runtime: SimRuntime): Promise<{ status: number; body: any }> {
  const res = await runtime.get('/ready');
  return { status: res.status, body: await res.json() };
}

describe('gateway /ready with Redis configured but unreachable (simulation)', () => {
  let runtime: SimRuntime;
  let deadRedisUrl: string;

  beforeAll(async () => {
    deadRedisUrl = `redis://127.0.0.1:${await freePort()}`; // nothing listens there
    clearDb();
    seedReachChurch();
    runtime = await createSimulation({
      env: {
        REDIS_URL: deadRedisUrl,
        REDIS_CONNECT_TIMEOUT_MS: '300',
        ADMIN_API_TOKEN: 'p19-admin-token',
        PORTAL_JWT_SECRET: 'p19-portal-jwt-secret',
        SECRET_ENCRYPTION_KEY: 'p19-secret-encryption-key-0123456789',
      },
    });
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    restoreEnv();
  });

  afterEach(() => {
    dbState.simulatedDbHealth = undefined;
    process.env.NODE_ENV = savedEnv.NODE_ENV ?? 'test';
    for (const k of SECRET_KEYS) process.env[k] = { ADMIN_API_TOKEN: 'p19-admin-token', PORTAL_JWT_SECRET: 'p19-portal-jwt-secret', SECRET_ENCRYPTION_KEY: 'p19-secret-encryption-key-0123456789' }[k];
  });

  it('is NOT ready: the queue fell back to memory, the rate limiter and EventBus never connected', async () => {
    const { status, body } = await ready(runtime);
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.dependencies.queue).toBe('memory-fallback');
    expect(body.dependencies.rateLimiter).toBe('redis-disconnected');
    expect(body.dependencies.eventBus).toBe('disconnected');
    expect(body.failing).toEqual(expect.arrayContaining(['queue', 'rateLimiter', 'eventBus']));
    // Everything that IS working is still reported as such.
    expect(body.dependencies.database).toBe('healthy');
    expect(body.dependencies.providers).toBe('ready');
    expect(body.dependencies.secrets).toBe('configured');
    expect(body.failing).not.toContain('database');
    expect(body.failing).not.toContain('providers');
    expect(body.failing).not.toContain('secrets');
  });

  it("the gateway queue really is the per-process MemoryStore the probe reports (B1's fallback)", async () => {
    expect(runtime.gatewayStore).toBeInstanceOf(MemoryStore);
  });

  it('PHASE14-01 residual: getRateLimiterInfo() no longer claims storeBacked while Redis is unreachable', async () => {
    const { AuthService } = await import('../../../services/api-gateway/src/auth');
    const info = new AuthService().getRateLimiterInfo();
    expect(info.type).toBe('redis');
    expect(info.redisConfigured).toBe(true);
    expect(info.connection).not.toBe('ready');
    expect(info.storeBacked).toBe(false);
  });

  it('required secrets: a missing one fails readiness in production and names it; outside production it is only reported', async () => {
    delete process.env.PORTAL_JWT_SECRET;

    const dev = await ready(runtime);
    expect(dev.body.dependencies.secrets).toBe('missing-non-production');
    expect(dev.body.failing).not.toContain('secrets');
    expect(dev.body.missingSecrets).toEqual(['PORTAL_JWT_SECRET']);

    process.env.NODE_ENV = 'production';
    const prod = await ready(runtime);
    expect(prod.status).toBe(503);
    expect(prod.body.dependencies.secrets).toBe('missing');
    expect(prod.body.failing).toContain('secrets');
    expect(prod.body.missingSecrets).toEqual(['PORTAL_JWT_SECRET']);
    // No secret VALUE is ever echoed, only names.
    expect(JSON.stringify(prod.body)).not.toContain('p19-');
  });

  it("PHASE19-01: a slow but reachable database ('degraded' grade) does not fail readiness", async () => {
    dbState.simulatedDbHealth = 'degraded';
    const { body } = await ready(runtime);
    expect(body.dependencies.database).toBe('degraded');
    // Counted as UP — not merely a down dependency still inside the grace period.
    expect(body.failing).not.toContain('database');
    expect(body.degraded).not.toContain('database');

    dbState.simulatedDbHealth = 'unhealthy';
    const down = await ready(runtime);
    expect(down.body.dependencies.database).toBe('unhealthy');
    // It was up before, so it is inside the grace period, reported as degraded.
    expect(down.body.degraded).toContain('database');
  });
});

describe('worker /ready (createWorkerReadiness, simulation)', () => {
  const healthyDb = async () => ({ status: 'healthy' });
  const providersLoaded = () => ({ loaded: true, secretFailures: [] });
  const busUp = { getRedisStatus: () => 'connected' as const };

  afterEach(restoreEnv);

  function manager(running: boolean) {
    return { isRunning: () => running };
  }

  it('is NOT ready when its queue silently fell back to a private MemoryStore (it polls a queue nobody enqueues into)', async () => {
    const url = `redis://127.0.0.1:${await freePort()}`;
    const store = await createStore(url, { connectTimeoutMs: 300, warn: () => undefined });
    const check = createWorkerReadiness({
      manager: manager(true), store, redisUrl: url,
      providerState: providersLoaded, eventBus: busUp, checkDatabase: healthyDb,
    });
    const { httpStatus, body } = await check();
    expect(httpStatus).toBe(503);
    expect(body.status).toBe('not-ready');
    expect(body.running).toBe(true);
    expect(body.dependencies.queue).toBe('memory-fallback');
    expect(body.failing).toEqual(['queue']);
  });

  it('is NOT ready without a database, and IS ready once every dependency is up', async () => {
    let dbUp = false;
    const gate = new ReadinessGate({ graceMs: 60_000 });
    const check = createWorkerReadiness({
      manager: manager(true), store: new MemoryStore(), redisUrl: 'memory',
      providerState: providersLoaded, eventBus: busUp,
      checkDatabase: async () => {
        if (!dbUp) throw new Error('DATABASE_URL environment variable is not set');
        return { status: 'healthy' };
      },
      gate,
    });
    const noDb = await check();
    expect(noDb.httpStatus).toBe(503);
    expect(noDb.body.dependencies.database).toBe('unreachable');
    expect(noDb.body.failing).toEqual(['database']);

    dbUp = true;
    const ok = await check();
    expect(ok.httpStatus).toBe(200);
    expect(ok.body.status).toBe('ready');
    expect(ok.body.failing).toEqual([]);
  });

  it('is NOT ready when the poll loop is stopped', async () => {
    const real = new WorkerManager(new MemoryStore(), createKeys('p19-sim'), DEFAULT_WORKER_CONFIG);
    const check = createWorkerReadiness({
      manager: real, store: new MemoryStore(), redisUrl: 'memory',
      providerState: providersLoaded, eventBus: busUp, checkDatabase: healthyDb,
    });
    const { httpStatus, body } = await check();
    expect(httpStatus).toBe(503);
    expect(body.running).toBe(false);
    expect(body.dependencies.running).toBe('stopped');
  });

  it('in production, a missing WEBHOOK_HMAC_SECRET (every payment webhook job would be rejected) fails readiness', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SECRET_ENCRYPTION_KEY = 'p19-key';
    delete process.env.WEBHOOK_HMAC_SECRET;
    const store = new MemoryStore();
    const check = createWorkerReadiness({
      manager: manager(true), store, redisUrl: 'redis://configured:6379',
      providerState: providersLoaded, eventBus: busUp, checkDatabase: healthyDb,
    });
    const { httpStatus, body } = await check();
    expect(httpStatus).toBe(503);
    expect(body.missingSecrets).toEqual(['WEBHOOK_HMAC_SECRET']);
    expect(body.failing).toEqual(expect.arrayContaining(['secrets', 'queue']));
  });

  it('a provider state that never loaded, or whose secrets cannot be decrypted, fails readiness', async () => {
    const cases: Array<[{ loaded: boolean; secretFailures: unknown[] }, string]> = [
      [{ loaded: false, secretFailures: [] }, 'not-loaded'],
      [{ loaded: true, secretFailures: [{ slug: 'stripe' }] }, 'degraded'],
    ];
    for (const [state, detail] of cases) {
      const check = createWorkerReadiness({
        manager: manager(true), store: new MemoryStore(), redisUrl: 'memory',
        providerState: () => state, eventBus: busUp, checkDatabase: healthyDb,
      });
      const { httpStatus, body } = await check();
      expect(httpStatus).toBe(503);
      expect(body.dependencies.providers).toBe(detail);
    }
  });
});
