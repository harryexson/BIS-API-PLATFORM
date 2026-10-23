import { beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { clearDb, seedReachChurch, installDatabaseMock, dbState, APP_SLUG } from './db';
import { createSimulation, type SimRuntime } from './harness';
import {
  registerAdminAuthScenarios,
  adminAuthEnv,
  newAdminTokens,
  ADMIN_AUTH_ENV_KEYS,
  type AdminAuthWorld,
} from './admin-auth.scenarios';

/**
 * Phase 20-21 admin-auth scenarios (see admin-auth.scenarios.ts) against the
 * in-memory database double and the gateway's in-memory limiter (REDIS_URL
 * unset), so they run in every plain `npx vitest run`. Real backends:
 * admin-auth.redis.simulation.test.ts, admin-auth.postgres.integration.test.ts.
 */

const tokens = newAdminTokens();
const ENV_KEYS = [...ADMIN_AUTH_ENV_KEYS, 'REDIS_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let runtime: SimRuntime;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  clearDb();
  seedReachChurch();
  runtime = await createSimulation({ env: adminAuthEnv(tokens) });
}, 30_000);

afterAll(async () => {
  await runtime.close();
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

registerAdminAuthScenarios(() => world, 'in-memory');
