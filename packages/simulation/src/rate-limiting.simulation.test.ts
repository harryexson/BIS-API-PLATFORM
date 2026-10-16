import { beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { randomBytes } from 'node:crypto';
import { clearDb, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import { registerRateLimitScenarios, rateLimitEnv, RATE_LIMIT_ENV_KEYS } from './rate-limiting.scenarios';

/**
 * Phase 14 gateway rate-limiting scenarios (see rate-limiting.scenarios.ts)
 * against the gateway's in-memory limiter (REDIS_URL unset), so they run in
 * every plain `npx vitest run`. The same scenarios against RateLimiterRedis on
 * a real redis-server: rate-limiting.redis.simulation.test.ts.
 */

const ADMIN_TOKEN = 'p14-admin-token-' + randomBytes(8).toString('hex');
const ENV_KEYS = [...RATE_LIMIT_ENV_KEYS, 'REDIS_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let runtime: SimRuntime;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  clearDb();
  seedReachChurch();
  runtime = await createSimulation({ env: rateLimitEnv(ADMIN_TOKEN) });
}, 30_000);

afterAll(async () => {
  await runtime.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}, 15_000);

registerRateLimitScenarios(() => runtime, ADMIN_TOKEN, 'in-memory limiter');
