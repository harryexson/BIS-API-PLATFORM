import { describe, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Phase 7 — the adversarial tenant-isolation suite (tenant-isolation.scenarios.ts)
 * run through the REAL gateway (every route, middleware and repository is
 * production code) against a REAL PostgreSQL database migrated from zero.
 * The ONLY substitution is connection.ts's getDb(): a postgres-js drizzle
 * handle over the test database instead of the neon-http one (same SQL).
 * Unlike the simulation double, every WHERE clause that enforces the tenant
 * boundary here is Postgres's own.
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/tenant-isolation.postgres.integration.test.ts
 *
 * Skipped when TEST_POSTGRES_URL is unset. A local Redis (REDIS_URL or
 * redis://localhost:6379), when present, backs the gateway's job queue
 * exactly as in production; otherwise the gateway falls back to its
 * in-memory store, which this suite does not depend on.
 */

const pg = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('tenant-isolation test database not initialised');
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
import { registerTenantIsolationScenarios, type IsolationWorld } from './tenant-isolation.scenarios';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const ADMIN_TOKEN = 'p7-admin-token-pg-0123456789abcdef';
const SECRET_KEY = 'p7-pg-secret-encryption-key-0123456789abcdef';

describe.skipIf(!ADMIN_URL)('Phase 7 — tenant isolation as a hard boundary (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  let world: IsolationWorld;

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p7');
    pg.db = database.db;

    const {
      ApplicationRegistry,
      applicationRepository,
      apiKeyRepository,
      tenantRepository,
      tenantApplicationLinkRepository,
      supplierRepository,
    } = await import('@company/database');

    const suffix = randomBytes(4).toString('hex');
    const registry = new ApplicationRegistry(applicationRepository, apiKeyRepository);
    // The shared application: many congregations under one registration.
    const shared = await registry.createApplication({ name: `Reach Church ${suffix}`, slug: `reach-church-${suffix}` });
    // An independent second application.
    const other = await registry.createApplication({ name: `STAYSCAPE ${suffix}`, slug: `stayscape-${suffix}` });

    const tenantA = await tenantRepository.create({ name: 'Grace Congregation', slug: `grace-${suffix}` });
    const tenantB = await tenantRepository.create({ name: 'Hope Congregation', slug: `hope-${suffix}` });
    const otherTenant = await tenantRepository.create({ name: 'Lakeside Hosts', slug: `lakeside-${suffix}` });
    const unlinked = await tenantRepository.create({ name: 'Unlinked Congregation', slug: `unlinked-${suffix}` });
    await tenantApplicationLinkRepository.link(tenantA.id, shared.application.id);
    await tenantApplicationLinkRepository.link(tenantB.id, shared.application.id);
    await tenantApplicationLinkRepository.link(otherTenant.id, other.application.id);

    const supplierA = await supplierRepository.create({
      applicationId: shared.application.id, tenantId: tenantA.id, name: 'Grace Chapel Bookshop', slug: 'grace-bookshop', type: 'organization',
    });
    const supplierB = await supplierRepository.create({
      applicationId: shared.application.id, tenantId: tenantB.id, name: 'Hope Chapel Cafe', slug: 'hope-cafe', type: 'organization',
    });
    const otherAppSupplier = await supplierRepository.create({
      applicationId: other.application.id, tenantId: otherTenant.id, name: 'Lakeside Lodge', slug: 'lakeside-lodge', type: 'hotel',
    });

    runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY } });

    world = {
      runtime,
      appSlug: shared.application.slug,
      apiKey: shared.apiKey.raw,
      tenantA: tenantA.id,
      tenantB: tenantB.id,
      unlinkedTenant: unlinked.id,
      otherApp: { slug: other.application.slug, apiKey: other.apiKey.raw, tenantId: otherTenant.id },
      adminToken: ADMIN_TOKEN,
      supplierA: { id: supplierA.id, slug: supplierA.slug },
      supplierB: { id: supplierB.id, slug: supplierB.slug },
      otherAppSupplier: { id: otherAppSupplier.id, slug: otherAppSupplier.slug },
      async webhookEventRow(providerId, providerEventId) {
        const rows = await database.client`
          SELECT app_id, tenant_id FROM webhook_events
          WHERE provider_id = ${providerId} AND provider_event_id = ${providerEventId}`;
        return rows[0] ? { appId: rows[0].app_id, tenantId: rows[0].tenant_id } : undefined;
      },
      async transactionRow(id) {
        if (!id) return undefined;
        const rows = await database.client`SELECT app_id, tenant_id, metadata FROM transactions WHERE id = ${id}::uuid`;
        return rows[0] ? { appId: rows[0].app_id, tenantId: rows[0].tenant_id, metadata: rows[0].metadata } : undefined;
      },
      startWorker: () => runtime.makeWorker({ store: runtime.gatewayStore, keys: runtime.gatewayKeys }),
    };
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  }, 30_000);

  registerTenantIsolationScenarios(() => world);
});
