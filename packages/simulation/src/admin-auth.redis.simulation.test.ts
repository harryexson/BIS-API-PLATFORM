import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { clearDb, seedReachChurch, installDatabaseMock, dbState, APP_SLUG } from './db';
import { createSimulation, type SimRuntime } from './harness';
import {
  registerAdminAuthScenarios,
  adminAuthEnv,
  newAdminTokens,
  ADMIN_AUTH_ENV_KEYS,
  ADMIN_FAILURES,
  type AdminAuthWorld,
} from './admin-auth.scenarios';
import { redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Phase 20-21 admin-auth scenarios (see admin-auth.scenarios.ts) with the
 * gateway's limiters — including the dedicated failed-admin-attempt counter
 * — on a REAL, spawned redis-server (TEST_REDIS_URL wins if set): the
 * production configuration. Skipped when no redis-server is available.
 */

const tokens = newAdminTokens();
const ENV_KEYS = [...ADMIN_AUTH_ENV_KEYS, 'REDIS_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe.skipIf(!redisAvailable)('Phase 20-21 admin auth on a real Redis', () => {
  let redis: TestRedis;
  let runtime: SimRuntime;

  beforeAll(async () => {
    redis = await startTestRedis();
    clearDb();
    seedReachChurch();
    runtime = await createSimulation({ env: { ...adminAuthEnv(tokens), REDIS_URL: redis.url } });
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    await redis?.stop();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }, 15_000);

  const world: AdminAuthWorld = {
    get runtime() {
      return runtime;
    },
    tokens,
    customerId: `app_${APP_SLUG}`,
    async setAuditWritesFailing(failing) {
      dbState.failAuditWrites = failing;
    },
    async countNotes() {
      return dbState.customerNotes.filter((n) => n.applicationId === `app_${APP_SLUG}`).length;
    },
  };

  registerAdminAuthScenarios(() => world, 'real Redis');

  it('PHASE14-06: the failed-attempt counter is its own Redis namespace, shared by every gateway replica', async () => {
    const prefix = process.env.RATE_LIMIT_KEY_PREFIX!;
    const client = new Redis(redis.url);
    try {
      // The scenarios above locked addresses out through the real gateway: the
      // counters are in Redis under the dedicated namespace, apart from the
      // general per-IP buckets.
      const failKeys = await client.keys(`${prefix}-admin-fail:ip:*`);
      expect(failKeys.length).toBeGreaterThan(0);
      const generalKeys = await client.keys(`${prefix}:ip:*`);
      expect(generalKeys.length).toBeGreaterThan(0);
      expect(failKeys.some((k) => generalKeys.includes(k))).toBe(false);

      // Two independent AuthService instances = two replicas, one Redis:
      // failures recorded on A lock the address out on B.
      const { AuthService } = await import('../../../services/api-gateway/src/auth');
      const limit = { windowMs: 60_000, max: ADMIN_FAILURES };
      const replicaA = new AuthService({ adminAuthFailureLimit: limit });
      const replicaB = new AuthService({ adminAuthFailureLimit: limit });
      const ip = 'replica-test-' + randomBytes(4).toString('hex');
      for (let i = 0; i < ADMIN_FAILURES; i++) {
        expect((await replicaA.recordAdminAuthFailure(ip)).locked).toBe(false);
      }
      expect(await replicaB.adminAuthLockState(ip)).toMatchObject({ locked: true, failures: ADMIN_FAILURES });
      expect(await client.get(`${prefix}-admin-fail:ip:${ip}`)).toBe(String(ADMIN_FAILURES));
      // A success on B clears it for A too.
      await replicaB.clearAdminAuthFailures(ip);
      expect((await replicaA.adminAuthLockState(ip)).locked).toBe(false);
    } finally {
      client.disconnect();
    }
  });
});
