import { describe, beforeAll, afterAll, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { randomUUID } from 'node:crypto';
import {
  dbState,
  clearDb,
  seedReachChurch,
  installDatabaseMock,
  APP_SLUG,
  API_KEY,
  TENANT_ID,
  OTHER_TENANT_ID,
  OTHER_APP_SLUG,
  OTHER_API_KEY,
  OTHER_TENANT_ID_HAULPRO,
  type SupplierRow,
} from './db';
import { createSimulation, type SimRuntime } from './harness';
import { registerTenantIsolationScenarios, type IsolationWorld } from './tenant-isolation.scenarios';

/**
 * Phase 7 adversarial tenant-isolation suite (see tenant-isolation.scenarios.ts)
 * against the in-memory database double, so it runs in every plain
 * `npx vitest run`. The authoritative run of the SAME scenarios against the
 * real repositories on real PostgreSQL is
 * tenant-isolation.postgres.integration.test.ts.
 *
 * World: Reach Church (one application) with TWO linked tenants — the main
 * congregation (TENANT_ID) and a second congregation added here — plus
 * HaulPro as the independent second application, and 'ten_unrelated' as a
 * tenant that exists but is not linked to Reach Church.
 */

const TENANT_B = 'ten_reach_second_congregation';
const ADMIN_TOKEN = 'p7-admin-token-sim-0123456789';
// Webhook endpoint signing secrets are encrypted at rest (AES-256-GCM).
const SECRET_KEY = 'p7-sim-secret-encryption-key-0123456789abcdef';

function supplier(applicationId: string, tenantId: string, slug: string): SupplierRow {
  const row: SupplierRow = {
    id: randomUUID(),
    applicationId,
    tenantId,
    name: slug,
    slug,
    type: 'hotel',
    status: 'active',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  dbState.suppliers.push(row);
  return row;
}

let runtime: SimRuntime;
let world: IsolationWorld;

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  dbState.tenants.push({
    id: TENANT_B,
    slug: 'reach-second-congregation',
    name: 'Reach Church — Second Congregation',
    status: 'active',
    countryCode: 'US',
    currency: 'USD',
  });
  dbState.tenantLinks.push({ tenantId: TENANT_B, applicationId: `app_${APP_SLUG}`, status: 'active' });

  const supplierA = supplier(`app_${APP_SLUG}`, TENANT_ID, 'grace-chapel');
  const supplierB = supplier(`app_${APP_SLUG}`, TENANT_B, 'hope-chapel');
  const otherAppSupplier = supplier(`app_${OTHER_APP_SLUG}`, OTHER_TENANT_ID_HAULPRO, 'depot-1');

  runtime = await createSimulation({
    env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY },
  });

  world = {
    runtime,
    appSlug: APP_SLUG,
    apiKey: API_KEY,
    tenantA: TENANT_ID,
    tenantB: TENANT_B,
    unlinkedTenant: OTHER_TENANT_ID,
    otherApp: { slug: OTHER_APP_SLUG, apiKey: OTHER_API_KEY, tenantId: OTHER_TENANT_ID_HAULPRO },
    adminToken: ADMIN_TOKEN,
    supplierA: { id: supplierA.id, slug: supplierA.slug },
    supplierB: { id: supplierB.id, slug: supplierB.slug },
    otherAppSupplier: { id: otherAppSupplier.id, slug: otherAppSupplier.slug },
    async webhookEventRow(providerId, providerEventId) {
      const row = dbState.webhookEvents.find((e) => e.providerId === providerId && e.providerEventId === providerEventId);
      return row ? { appId: row.appId, tenantId: row.tenantId } : undefined;
    },
    async transactionRow(id) {
      const row = dbState.transactions.find((t) => t.id === id);
      return row ? { appId: row.appId, tenantId: row.tenantId, metadata: row.metadata } : undefined;
    },
    startWorker: () => runtime.makeWorker({ store: runtime.gatewayStore, keys: runtime.gatewayKeys }),
  };
}, 30_000);

afterAll(async () => {
  await runtime?.close();
}, 15_000);

describe('Phase 7 — tenant isolation as a hard boundary (in-memory database double)', () => {
  registerTenantIsolationScenarios(() => world);
});
