import { beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { randomBytes } from 'node:crypto';
import { clearDb, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import { registerTrustProxyScenarios, trustProxyEnv, TRUST_PROXY_ENV_KEYS } from './trust-proxy.scenarios';

/**
 * Phase 23-24 (PHASE14-03 / PHASE20-02) trust-proxy scenarios (see
 * trust-proxy.scenarios.ts) with TRUST_PROXY=true: blanket trust, which the gateway must REFUSE.
 * The gateway reads TRUST_PROXY once at module load, so each setting gets
 * its own file (vitest isolates modules per file).
 */

const ALICE = randomBytes(32).toString('hex');
const savedEnv = Object.fromEntries(TRUST_PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));

let runtime: SimRuntime;

beforeAll(async () => {
  delete process.env.REDIS_URL;
  delete process.env.ADMIN_API_TOKEN;
  clearDb();
  seedReachChurch();
  runtime = await createSimulation({ env: trustProxyEnv('true', ALICE) });
}, 30_000);

afterAll(async () => {
  await runtime.close();
  for (const k of TRUST_PROXY_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}, 15_000);

registerTrustProxyScenarios(() => runtime, ALICE, 'refused');
