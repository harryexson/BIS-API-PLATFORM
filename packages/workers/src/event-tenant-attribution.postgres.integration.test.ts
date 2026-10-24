import { describe, beforeAll, afterAll, vi } from 'vitest';

/**
 * Phase 16 — events.tenant_id attribution against a REAL PostgreSQL migrated
 * from zero: the production eventRepository writes the row, and the test
 * reads events.tenant_id back with SQL.
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/workers/src/event-tenant-attribution.postgres.integration.test.ts
 *
 * Skipped when TEST_POSTGRES_URL is unset; the in-memory run of the same
 * scenarios is event-tenant-attribution.test.ts.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;

const pg = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('not available');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy', latencyMs: 0, details: {} }),
  schema: {},
}));

import { createMigratedTestDatabase, type MigratedTestDatabase } from '../../database/src/test-utils/postgres-test-db';
import { registerEventTenantAttributionScenarios } from './event-tenant-attribution.scenarios';

const APP = 'p16-events-app';

describe.skipIf(!ADMIN_URL)('Phase 16 — events.tenant_id attribution (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p16ev');
    pg.db = database.db;
    // events.app_id is a FK to applications.slug.
    await database.client`INSERT INTO applications (name, slug) VALUES ('P16 Events', ${APP})`;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  registerEventTenantAttributionScenarios(() => ({
    appId: APP,
    async storedTenantOf(decisionReason: string) {
      const rows = await database.client`SELECT tenant_id FROM events WHERE decision_reason = ${decisionReason}`;
      if (rows.length !== 1) throw new Error(`expected exactly one events row for ${decisionReason}, found ${rows.length}`);
      return rows[0].tenant_id as string | null;
    },
  }));
});
