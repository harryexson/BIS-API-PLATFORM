import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Phase 20-21 — the admin-auth suite (admin-auth.scenarios.ts) through the
 * REAL gateway against a REAL PostgreSQL database migrated from zero
 * (including 0022_admin_audit_identity). The ONLY substitution is
 * connection.ts's getDb(): a postgres-js drizzle handle over the test
 * database instead of the neon-http one (same SQL). The audit rows, the CRM
 * notes/comments and their authors are real rows; the "audit write fails"
 * fault is a real one (audit_logs is renamed away for the duration).
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/admin-auth.postgres.integration.test.ts
 *
 * Skipped when TEST_POSTGRES_URL is unset.
 */

const pg = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('admin-auth test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('getRawSql is not available in the postgres test harness');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy', latencyMs: 0, details: {} }),
  schema: {},
}));

import { createMigratedTestDatabase, type MigratedTestDatabase } from '../../database/src/test-utils/postgres-test-db';
import { createSimulation, waitFor, type SimRuntime } from './harness';
import {
  registerAdminAuthScenarios,
  adminAuthEnv,
  newAdminTokens,
  send,
  ADMIN_AUTH_ENV_KEYS,
  type AdminAuthWorld,
} from './admin-auth.scenarios';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const tokens = newAdminTokens();
const savedEnv = Object.fromEntries(ADMIN_AUTH_ENV_KEYS.map((k) => [k, process.env[k]]));

describe.skipIf(!ADMIN_URL)('Phase 20-21 — admin auth, identity and audit (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  let customerId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p20');
    pg.db = database.db;

    const { ApplicationRegistry, applicationRepository, apiKeyRepository } = await import('@company/database');
    const suffix = randomBytes(4).toString('hex');
    const created = await new ApplicationRegistry(applicationRepository, apiKeyRepository).createApplication({
      name: `P20 App ${suffix}`,
      slug: `p20-app-${suffix}`,
    });
    customerId = created.application.id;

    runtime = await createSimulation({ env: adminAuthEnv(tokens) });
    const gateway = await import('../../../services/api-gateway/src/app');
    await gateway.providerStateReady;
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
    for (const k of ADMIN_AUTH_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }, 30_000);

  const world: AdminAuthWorld = {
    get runtime() {
      return runtime;
    },
    tokens,
    get customerId() {
      return customerId;
    },
    async setAuditWritesFailing(failing) {
      if (failing) await database.client`ALTER TABLE audit_logs RENAME TO audit_logs_p20_offline`;
      else await database.client`ALTER TABLE audit_logs_p20_offline RENAME TO audit_logs`;
    },
    async countNotes() {
      const [{ n }] = await database.client`SELECT count(*)::int AS n FROM customer_notes WHERE application_id = ${customerId}::uuid`;
      return n;
    },
  };

  registerAdminAuthScenarios(() => world, 'real PostgreSQL');

  it('the audit rows are real platform-level audit_logs rows (0022 columns), and the CRM author column holds the admin id', async () => {
    const res = await send(runtime.baseUrl, '127.0.0.1', 'POST', `/api/dashboard/customers/${customerId}/notes`, { 'x-admin-token': tokens.bob }, {
      body: 'p20 pg note',
      authorName: 'not-bob',
    });
    expect(res.status).toBe(201);

    const [note] = await database.client`SELECT author_name FROM customer_notes WHERE id = ${res.json.id}::uuid`;
    expect(note.author_name).toBe('bob');

    let rows: any[] = [];
    await waitFor(async () => {
      rows = await database.client`
        SELECT application_id, user_id, actor_type, actor_id, action, resource, outcome, status_code, ip_address, details
        FROM audit_logs WHERE actor_id = 'bob' AND action = 'POST /api/dashboard/customers/:id/notes' AND status_code = 201`;
      return rows.length > 0;
    }, { label: "bob's note audited in Postgres" });
    expect(rows[0]).toMatchObject({
      application_id: null,
      user_id: null,
      actor_type: 'admin',
      actor_id: 'bob',
      resource: 'admin_api',
      outcome: 'success',
      status_code: 201,
    });
    expect(JSON.parse(rows[0].details)).toMatchObject({ route: '/api/dashboard/customers/:id/notes', params: { id: customerId } });
    expect(rows[0].details).not.toContain('p20 pg note');

    // Denied attempts are rows too, without an actor.
    const [{ denied }] = await database.client`
      SELECT count(*)::int AS denied FROM audit_logs
      WHERE actor_type = 'admin' AND actor_id IS NULL AND action IN ('admin.auth.denied', 'admin.auth.locked')`;
    expect(denied).toBeGreaterThan(0);
    // No plaintext admin token anywhere in the audit table.
    const [{ leaked }] = await database.client`
      SELECT count(*)::int AS leaked FROM audit_logs
      WHERE details LIKE ${'%' + tokens.alice + '%'} OR details LIKE ${'%' + tokens.bob + '%'}`;
    expect(leaked).toBe(0);
  });
});
