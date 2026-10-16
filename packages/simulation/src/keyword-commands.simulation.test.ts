import { describe, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { dbState, clearDb, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';
import {
  registerKeywordCommandScenarios,
  seedKeywordParties,
  type KeywordWorld,
} from './keyword-commands.scenarios';

/**
 * Phase 9 keyword-command suite (see keyword-commands.scenarios.ts) against
 * the in-memory database double, so it runs in every plain `npx vitest run`.
 * The authoritative run of the SAME scenarios against the real repositories
 * on real PostgreSQL is keyword-commands.postgres.integration.test.ts.
 */

const ADMIN_TOKEN = 'p9-admin-token-sim-0123456789';
const SECRET_KEY = 'p9-sim-secret-encryption-key-0123456789abcdef';

let runtime: SimRuntime;
let world: KeywordWorld;

describe('Phase 9 — tenant-configurable keyword commands (in-memory double)', () => {
  beforeAll(async () => {
    clearDb();
    runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY } });
    const parties = await seedKeywordParties();
    world = {
      runtime,
      adminToken: ADMIN_TOKEN,
      ...parties,
      async eventsFor(customer) {
        return dbState.events
          .filter((e) => {
            const p = (e.payload ?? {}) as any;
            return p.sender === customer || p.recipient === customer;
          })
          .map((e) => ({ appId: e.appId, category: e.category, decisionReason: e.decisionReason, payload: e.payload as any }));
      },
      startWorker: () => runtime.makeWorker({ store: runtime.gatewayStore, keys: runtime.gatewayKeys }),
    };
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
  });

  registerKeywordCommandScenarios(() => world);
});
