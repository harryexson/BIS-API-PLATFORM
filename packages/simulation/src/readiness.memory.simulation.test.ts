import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { clearDb, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import { EventBus } from '@company/events';
import { MemoryStore } from '@company/workers';

/**
 * Phase 19 — REDIS_URL=memory is createStore()'s explicit single-process
 * sentinel. The gateway's rate limiter and the EventBus used to treat it as
 * a Redis host named "memory" (ioredis → memory:6379), so with honest
 * readiness the gateway would report a Redis that never connects. In this
 * mode nothing is Redis-backed ON PURPOSE: ready outside production, not
 * ready in production (a per-process queue can't reach the worker).
 */

const ENV_KEYS = ['REDIS_URL', 'NODE_ENV', 'ADMIN_API_TOKEN', 'ADMIN_API_CREDENTIALS', 'PORTAL_JWT_SECRET', 'SECRET_ENCRYPTION_KEY'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe('gateway /ready in explicit single-process mode (REDIS_URL=memory)', () => {
  let runtime: SimRuntime;

  beforeAll(async () => {
    clearDb();
    seedReachChurch();
    runtime = await createSimulation({
      env: {
        REDIS_URL: 'memory',
        // Phase 20-21 (C7): a named admin credential — production no longer
        // accepts the shared ADMIN_API_TOKEN, and this suite asserts that in
        // production ONLY the queue fails readiness.
        ADMIN_API_CREDENTIALS: 'p19m-admin:' + 'a'.repeat(64),
        PORTAL_JWT_SECRET: 'p19m-portal-jwt-secret',
        SECRET_ENCRYPTION_KEY: 'p19m-secret-encryption-key-0123456789',
      },
    });
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('nothing tries to reach a Redis host called "memory"', async () => {
    expect(runtime.gatewayStore).toBeInstanceOf(MemoryStore);
    expect(EventBus.getInstance().getRedisStatus()).toBe('not-configured');
    const { AuthService } = await import('../../../services/api-gateway/src/auth');
    expect(new AuthService().getRateLimiterInfo()).toMatchObject({ type: 'memory', redisConfigured: false, storeBacked: false });
  });

  it('is ready outside production, every component reported as intentionally in-memory', async () => {
    const res = await runtime.get('/ready');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.failing).toEqual([]);
    expect(body.dependencies).toMatchObject({ queue: 'memory', rateLimiter: 'in-memory', eventBus: 'not-configured' });
  });

  it('is NOT ready in production: a per-process queue cannot reach the worker', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const res = await runtime.get('/ready');
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.failing).toEqual(['queue']);
      expect(body.dependencies.queue).toBe('memory');
    } finally {
      process.env.NODE_ENV = savedEnv.NODE_ENV ?? 'test';
    }
  });
});
