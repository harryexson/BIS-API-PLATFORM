import { describe, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { createHash } from 'node:crypto';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, APP_SLUG, API_KEY, TENANT_ID } from './db';
import { createSimulation, type SimRuntime } from './harness';
import { registerProviderStateScenarios, type ProviderStateWorld } from './provider-state.scenarios';

/**
 * Phase 15 provider-state suite (see provider-state.scenarios.ts) against the
 * in-memory database double, so it runs in every plain `npx vitest run`. The
 * authoritative run of the SAME scenarios against real PostgreSQL is
 * provider-state.postgres.integration.test.ts.
 */

const ADMIN_TOKEN = 'p15-admin-token-sim-0123456789';
const SECRET_KEY = 'p15-sim-secret-encryption-key-0123456789abcdef';
const LIVE_KEY = 'bap_live_reachchurch_p15';

let runtime: SimRuntime;
let world: ProviderStateWorld;

beforeAll(async () => {
  clearDb();
  seedReachChurch(); // API_KEY: environment 'development' → test tier
  dbState.apiKeys.push({
    id: 'key_reach_church_live_p15',
    keyHash: createHash('sha256').update(LIVE_KEY).digest('hex'),
    applicationId: `app_${APP_SLUG}`,
    environment: 'live',
    revokedAt: null,
    expiresAt: null,
  });

  runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY } });
  const gateway = await import('../../../services/api-gateway/src/app');
  await gateway.providerStateReady;
  const { providerStateStore } = await import('@company/database');

  world = {
    runtime,
    adminToken: ADMIN_TOKEN,
    tenantId: TENANT_ID,
    testTierKey: API_KEY,
    liveTierKey: LIVE_KEY,
    store: providerStateStore,
    syncGateway: () => gateway.syncProviderStateForTests(),
  };
}, 30_000);

afterAll(async () => {
  await runtime?.close();
}, 15_000);

describe('Phase 15 — provider registry persistence + secret handling (simulation database)', () => {
  registerProviderStateScenarios(() => world);
});
