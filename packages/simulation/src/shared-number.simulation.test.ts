import { describe, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { dbState, clearDb, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import {
  registerSharedNumberScenarios,
  seedSharedNumberParties,
  type SharedNumberWorld,
} from './shared-number.scenarios';

/**
 * Phase 8 shared-phone-number suite (see shared-number.scenarios.ts) against
 * the in-memory database double, so it runs in every plain `npx vitest run`.
 * The authoritative run of the SAME scenarios against the real repositories
 * on real PostgreSQL is shared-number.postgres.integration.test.ts.
 */

const ADMIN_TOKEN = 'p8-admin-token-sim-0123456789';
const SECRET_KEY = 'p8-sim-secret-encryption-key-0123456789abcdef';

let runtime: SimRuntime;
let world: SharedNumberWorld;

describe('Phase 8 — shared phone numbers: conversation ownership (in-memory double)', () => {
  beforeAll(async () => {
    clearDb();
    runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY } });
    const parties = await seedSharedNumberParties();
    world = {
      runtime,
      adminToken: ADMIN_TOKEN,
      ...parties,
      async eventsFor(customer) {
        return dbState.events
          .filter((e) => e.category === 'inbound' && (e.payload as any)?.sender === customer)
          .map((e) => ({ appId: e.appId, decisionReason: e.decisionReason, payload: e.payload as any }));
      },
      startWorker: () => runtime.makeWorker({ store: runtime.gatewayStore, keys: runtime.gatewayKeys }),
    };
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
  });

  registerSharedNumberScenarios(() => world);
});
