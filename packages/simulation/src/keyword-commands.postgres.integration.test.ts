import { describe, beforeAll, afterAll, vi } from 'vitest';

/**
 * Phase 9 — the keyword-command suite (keyword-commands.scenarios.ts) run
 * through the REAL gateway and REAL worker against a REAL PostgreSQL
 * database migrated from zero (including migration 0018). The ONLY
 * substitution is connection.ts's getDb(): a postgres-js drizzle handle over
 * the test database instead of the neon-http one (same SQL).
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/keyword-commands.postgres.integration.test.ts
 *
 * Skipped when TEST_POSTGRES_URL is unset.
 */

const pg = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('keyword-commands test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('getRawSql is not available in the postgres test harness');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy', latencyMs: 0, details: {} }),
  schema: {},
}));

import { createMigratedTestDatabase, type MigratedTestDatabase } from '../../database/src/test-utils/postgres-test-db';
import { createSimulation, type SimRuntime } from './harness';
import {
  registerKeywordCommandScenarios,
  seedKeywordParties,
  type KeywordWorld,
} from './keyword-commands.scenarios';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const ADMIN_TOKEN = 'p9-admin-token-pg-0123456789abcdef';
const SECRET_KEY = 'p9-pg-secret-encryption-key-0123456789abcdef';

describe.skipIf(!ADMIN_URL)('Phase 9 — tenant-configurable keyword commands (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  let world: KeywordWorld;

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p9');
    pg.db = database.db;
    runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY } });
    const parties = await seedKeywordParties();
    world = {
      runtime,
      adminToken: ADMIN_TOKEN,
      ...parties,
      async eventsFor(customer) {
        const rows = await database.client`
          SELECT app_id, category, decision_reason, payload FROM events
          WHERE payload->>'sender' = ${customer} OR payload->>'recipient' = ${customer}
          ORDER BY created_at`;
        return rows.map((r) => ({
          appId: r.app_id as string,
          category: r.category as string,
          decisionReason: r.decision_reason as string | null,
          payload: r.payload,
        }));
      },
      startWorker: () => runtime.makeWorker({ store: runtime.gatewayStore, keys: runtime.gatewayKeys }),
    };
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  }, 30_000);

  registerKeywordCommandScenarios(() => world);
});
