import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ProviderRegistry } from '@company/providers';

/**
 * Phase 25 — SECRET_ENCRYPTION_KEY lost, recovered with the CORRECTED
 * DISASTER_RECOVERY.md §4.2 procedure, through the REAL gateway routes, a
 * named Phase 20-21 admin credential and a REAL PostgreSQL migrated from
 * zero (only connection.ts's getDb() is substituted: postgres-js instead of
 * neon-http, same SQL):
 *
 *   1. generate a new key;
 *   2. BEFORE deploying it, clear the undecryptable ciphertext with the
 *      runbook's SQL (management configuration is kept);
 *   3. deploy the new key (= a fresh gateway process here);
 *   4. re-enter each credential: POST /api/dashboard/providers/:id/secrets
 *      with the on-call admin's own x-admin-token;
 *   5. verify: the row is encrypted under the new key and a restarted
 *      process / other replica (the worker) loads it.
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/secret-key-loss-recovery.postgres.integration.test.ts
 *
 * The pre-Phase-25 order (deploy the key, then re-enter) is refused — see
 * secret-key-loss-unrecovered.postgres.integration.test.ts.
 *
 * Skipped when TEST_POSTGRES_URL is unset.
 */

const pg = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('secret-key-loss test database not initialised');
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
  ONCALL_ADMIN_ID,
  KEY_LOSS_ENV_KEYS,
  newHexKey,
  namedAdminEnv,
  clearUndecryptableSecretsSql,
  seedProviderSecrets,
} from './secret-key-loss.shared';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const OLD_KEY = newHexKey();
const NEW_KEY = newHexKey();
const ADMIN_TOKEN = newHexKey();
const savedEnv = Object.fromEntries(KEY_LOSS_ENV_KEYS.map((k) => [k, process.env[k]]));

describe.skipIf(!ADMIN_URL)('Phase 25 — SECRET_ENCRYPTION_KEY lost: the corrected runbook procedure (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  let store: import('@company/providers').ProviderStateStore;
  const admin = { 'x-admin-token': ADMIN_TOKEN };

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p25kr');
    pg.db = database.db;
    const { providerStateStore } = await import('@company/database');
    store = providerStateStore;

    // Credentials (and one configuration change) stored while the old key was in force.
    process.env.SECRET_ENCRYPTION_KEY = OLD_KEY;
    await seedProviderSecrets(store);
    const template = ProviderRegistry.createIsolatedInstance().exportManagementForPersistence('stripe')!;
    expect((await store.saveManagement({ slug: 'stripe', name: 'Stripe', category: 'payment', management: { ...template, priority: 42 }, expectedVersion: 0 })).saved).toBe(true);

    // The old key is lost. Step 2: clear the undecryptable ciphertext BEFORE the new key is deployed.
    const cleared = await database.client.unsafe(clearUndecryptableSecretsSql('test'));
    expect(cleared.count).toBe(2);

    // Step 3: deploy the new key — a fresh gateway process.
    delete process.env.ADMIN_API_TOKEN;
    runtime = await createSimulation({ env: namedAdminEnv(ADMIN_TOKEN, NEW_KEY) });
    const gateway = await import('../../../services/api-gateway/src/app');
    await gateway.providerStateReady;
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
    for (const k of KEY_LOSS_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }, 30_000);

  it('after the clear + redeploy, provider state loads cleanly (/ready providers "ready") and configuration survived the clear', async () => {
    const body = await (await runtime.get('/ready')).json();
    expect(body.dependencies.providers).toBe('ready');
    expect(body.failing).not.toContain('providers');
    expect(runtime.registry.getSecretLoadFailures()).toEqual([]);
    const view = await (await runtime.get('/api/dashboard/providers/stripe/management', admin)).json();
    expect(view.priority).toBe(42);
  });

  it('step 4: each credential is re-entered through POST /api/dashboard/providers/:id/secrets (201, masked — the value is never echoed)', async () => {
    for (const [slug, value] of [['stripe', 'sk_test_p25_after_key_loss'], ['nmi', 'nmi_p25_after_key_loss']] as const) {
      const res = await runtime.post(`/api/dashboard/providers/${slug}/secrets`, { field: 'api_key', label: 'API key', value }, admin);
      expect(res.status).toBe(201);
      const meta = await res.json();
      expect(meta).toMatchObject({ field: 'api_key', label: 'API key' });
      expect(JSON.stringify(meta)).not.toContain(value);
    }
    const list = await (await runtime.get('/api/dashboard/providers/stripe/secrets', admin)).json();
    expect(list.map((s: { field: string }) => s.field)).toEqual(['api_key']);
    expect(runtime.registry.isProviderAvailable('stripe')).toBe(true);
  });

  it('step 5: the rows are now encrypted under the NEW key, and a restarted process / the worker loads them', async () => {
    const row = (await store.load('stripe'))!;
    expect(row.secretsVersion).toBe(1);
    expect(row.readSecrets()).toMatchObject([{ field: 'api_key', value: 'sk_test_p25_after_key_loss' }]);

    const restarted = ProviderRegistry.createIsolatedInstance();
    const report = await restarted.syncFromStore(store);
    expect(report.secretFailures).toEqual([]);
    expect(restarted.exportSecretsForPersistence('nmi')).toMatchObject([{ field: 'api_key', value: 'nmi_p25_after_key_loss' }]);
    expect(restarted.isProviderAvailable('stripe')).toBe(true);
  });

  it('every recovery write is audited under the named admin identity', async () => {
    let rows: Array<{ actor_id: string; resource: string }> = [];
    await waitFor(async () => {
      rows = await database.client`SELECT actor_id, resource FROM audit_logs
                                   WHERE action = 'POST /api/dashboard/providers/:id/secrets' AND status_code = 201`;
      return rows.length >= 2;
    }, { label: 'both re-entries audited' });
    expect(rows.every((r) => r.actor_id === ONCALL_ADMIN_ID)).toBe(true);
  });
});
