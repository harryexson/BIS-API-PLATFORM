import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { clearDb, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import { registerRateLimitScenarios, rateLimitEnv, RATE_LIMIT_ENV_KEYS, LIMIT } from './rate-limiting.scenarios';
import { redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Phase 14 gateway rate-limiting scenarios (see rate-limiting.scenarios.ts)
 * with the gateway's limiter backed by RateLimiterRedis on a REAL, spawned
 * redis-server (TEST_REDIS_URL wins if set) — the production configuration.
 * Skipped when no redis-server is available.
 */

const ADMIN_TOKEN = 'p14-admin-token-redis-' + randomBytes(8).toString('hex');
const ENV_KEYS = [...RATE_LIMIT_ENV_KEYS, 'REDIS_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe.skipIf(!redisAvailable)('gateway rate limiting on a real Redis', () => {
  let redis: TestRedis;
  let runtime: SimRuntime;

  beforeAll(async () => {
    redis = await startTestRedis();
    clearDb();
    seedReachChurch();
    runtime = await createSimulation({ env: { ...rateLimitEnv(ADMIN_TOKEN), REDIS_URL: redis.url } });
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    await redis?.stop();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }, 15_000);

  registerRateLimitScenarios(() => runtime, ADMIN_TOKEN, 'real Redis');

  it('the buckets live in Redis, so separate gateway replicas share one limit', async () => {
    // Both limiter tiers wrote their counters to Redis under this run's prefix.
    const prefix = process.env.RATE_LIMIT_KEY_PREFIX!;
    const client = new Redis(redis.url);
    try {
      const general = await client.keys(`${prefix}:ip:*`);
      const strict = await client.keys(`${prefix}-auth:ip:*`);
      const perApp = await client.keys(`${prefix}:app:*`);
      expect(general.length).toBeGreaterThan(0);
      expect(strict.length).toBeGreaterThan(0);
      expect(perApp.length).toBeGreaterThan(0);

      // Two independent AuthService instances = two gateway replicas, each with
      // its own in-process insurance limiter, one shared Redis. Alternating
      // requests between them must exhaust ONE shared budget of LIMIT, not
      // LIMIT per replica. (Imported here, after createSimulation set the env
      // the module reads at load.)
      const { AuthService } = await import('../../../services/api-gateway/src/auth');
      const replicaA = new AuthService({ rateLimit: { windowMs: 60_000, max: LIMIT } });
      const replicaB = new AuthService({ rateLimit: { windowMs: 60_000, max: LIMIT } });
      const bucket = 'ip:replica-test-' + randomBytes(4).toString('hex');
      const results: boolean[] = [];
      for (let i = 0; i < LIMIT * 2; i++) {
        results.push(await (i % 2 === 0 ? replicaA : replicaB).rateAllowed(bucket));
      }
      expect(results.filter(Boolean).length).toBe(LIMIT);
      expect(await client.get(`${prefix}:${bucket}`)).toBe(String(LIMIT * 2));
    } finally {
      client.disconnect();
    }
  });
});
