import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ProviderRegistry } from '@company/providers';

/**
 * Phase 15 — the provider-state suite (provider-state.scenarios.ts) through
 * the REAL gateway against a REAL PostgreSQL database migrated from zero
 * (including 0020_provider_management_persistence). The ONLY substitution is
 * connection.ts's getDb(): a postgres-js drizzle handle over the test
 * database instead of the neon-http one (same SQL). Every compare-and-set
 * here is Postgres's own single INSERT ... ON CONFLICT DO UPDATE ... WHERE.
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/provider-state.postgres.integration.test.ts
 *
 * Skipped when TEST_POSTGRES_URL is unset.
 */

const pg = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('provider-state test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('getRawSql is not available in the postgres test harness');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy', latencyMs: 0, details: {} }),
  schema: {},
}));

import {
  createMigratedTestDatabase,
  createPartiallyMigratedTestDatabase,
  type MigratedTestDatabase,
} from '../../database/src/test-utils/postgres-test-db';
import { createSimulation, type SimRuntime } from './harness';
import { registerProviderStateScenarios, type ProviderStateWorld } from './provider-state.scenarios';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const ADMIN_TOKEN = 'p15-admin-token-pg-0123456789abcdef';
const SECRET_KEY = 'p15-pg-secret-encryption-key-0123456789abcdef';

describe.skipIf(!ADMIN_URL)('Phase 15 — provider registry persistence + secret handling (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  let world: ProviderStateWorld;

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p15');
    pg.db = database.db;

    const {
      ApplicationRegistry,
      applicationRepository,
      apiKeyRepository,
      tenantRepository,
      tenantApplicationLinkRepository,
      generateApiKey,
      providerStateStore,
    } = await import('@company/database');

    const suffix = randomBytes(4).toString('hex');
    // createApplication issues a key in the application's environment —
    // 'development', i.e. the TEST tier.
    const created = await new ApplicationRegistry(applicationRepository, apiKeyRepository).createApplication({
      name: `P15 App ${suffix}`,
      slug: `p15-app-${suffix}`,
    });
    const live = generateApiKey();
    await apiKeyRepository.create({
      applicationId: created.application.id,
      keyHash: live.hash,
      prefix: live.prefix,
      environment: 'live',
    });
    const tenant = await tenantRepository.create({ name: 'P15 Tenant', slug: `p15-tenant-${suffix}` });
    await tenantApplicationLinkRepository.link(tenant.id, created.application.id);

    runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN, SECRET_ENCRYPTION_KEY: SECRET_KEY } });
    const gateway = await import('../../../services/api-gateway/src/app');
    await gateway.providerStateReady;

    world = {
      runtime,
      adminToken: ADMIN_TOKEN,
      tenantId: tenant.id,
      testTierKey: created.apiKey.raw,
      liveTierKey: live.raw,
      store: providerStateStore,
      syncGateway: () => gateway.syncProviderStateForTests(),
    };
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  }, 30_000);

  registerProviderStateScenarios(() => world);

  // Postgres-only: the compare-and-set itself, with writers genuinely
  // interleaved. (The registry-level scenario above re-reads before writing,
  // so it would pass even without the WHERE; this one would not.) Every
  // writer holds the SAME expected version, as N replicas that loaded the
  // same row would: exactly one single-statement
  // INSERT ... ON CONFLICT DO UPDATE ... WHERE version = expected wins.
  it('E12: of N concurrent writers holding the same version, exactly one wins (management and secrets); the losers change nothing', async () => {
    const store = world.store;
    const base = { slug: 'adyen', name: 'Adyen', category: 'payment' };
    const start = await store.load('adyen');
    const mv = start?.managementVersion ?? 0;
    const sv = start?.secretsVersion ?? 0;
    const template = ProviderRegistry.createIsolatedInstance().exportManagementForPersistence('adyen')!;

    const N = 12;
    const mResults = await Promise.all(
      Array.from({ length: N }, (_, i) => store.saveManagement({ ...base, management: { ...template, priority: 100 + i }, expectedVersion: mv })),
    );
    const mWinners = mResults.flatMap((r, i) => (r.saved ? [{ i, version: r.version }] : []));
    expect(mWinners).toHaveLength(1);
    expect(mWinners[0].version).toBe(mv + 1);

    const sResults = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.saveSecrets({ ...base, secrets: [{ field: 'api_key', label: 'k', value: `adyen_cas_${i}` }], expectedVersion: sv }),
      ),
    );
    const sWinners = sResults.flatMap((r, i) => (r.saved ? [{ i, version: r.version }] : []));
    expect(sWinners).toHaveLength(1);
    expect(sWinners[0].version).toBe(sv + 1);

    const row = (await store.load('adyen'))!;
    expect(row.managementVersion).toBe(mv + 1);
    expect((row.management as { priority: number }).priority).toBe(100 + mWinners[0].i);
    expect(row.secretsVersion).toBe(sv + 1);
    expect(row.readSecrets()).toEqual([{ field: 'api_key', label: 'k', value: `adyen_cas_${sWinners[0].i}` }]);
  });

  // Postgres-only: the upgrade path. Secrets an admin stored BEFORE Phase 15
  // (pre-0020 schema, written by the old persistProviderSecrets as a bare
  // [{field,label,value}] list) must still load after 0020 is applied —
  // replicas apply a row only when its version is newer than the 0 they
  // start at, so 0020's backfill (secrets_version = 1 where a secret exists)
  // is what keeps them from silently vanishing on deploy.
  it('migration 0020 upgrades a database at 0019: previously persisted secrets still load; rows without secrets stay at version 0', async () => {
    const { encryptSecret } = await import('@company/database');
    // 19 = journal idx of 0019_channel_decision_audit, the migration before 0020.
    const upgrade = await createPartiallyMigratedTestDatabase(ADMIN_URL!, 19, 'bis_p15up');
    const savedDb = pg.db;
    try {
      const { client } = upgrade;
      const before = await client`SELECT column_name FROM information_schema.columns
                                  WHERE table_name = 'provider_configs' AND column_name IN ('management_config', 'management_version', 'secrets_version')`;
      expect(before).toHaveLength(0);

      const legacy = encryptSecret(JSON.stringify([{ field: 'api_key', label: 'Secret key', value: 'sk_test_pre_phase15' }]));
      const [stripe] = await client`INSERT INTO providers (slug, name, category) VALUES ('stripe', 'Stripe', 'payment') RETURNING id`;
      const [nmi] = await client`INSERT INTO providers (slug, name, category) VALUES ('nmi', 'NMI', 'payment') RETURNING id`;
      await client`INSERT INTO provider_configs (provider_id, environment, encrypted_secret, secret_iv, secret_tag)
                   VALUES (${stripe.id}, 'test', ${legacy.encrypted}, ${legacy.iv}, ${legacy.tag})`;
      await client`INSERT INTO provider_configs (provider_id, environment) VALUES (${nmi.id}, 'test')`;

      await upgrade.migrateRest();

      const rows = await client`SELECT p.slug, c.secrets_version, c.management_version, c.management_config
                                FROM provider_configs c JOIN providers p ON p.id = c.provider_id ORDER BY p.slug`;
      expect(rows).toEqual([
        { slug: 'nmi', secrets_version: 0, management_version: 0, management_config: null },
        { slug: 'stripe', secrets_version: 1, management_version: 0, management_config: null },
      ]);

      // The REAL providerStateStore's SQL over the upgraded database, applied by a fresh process.
      pg.db = upgrade.db;
      const restarted = ProviderRegistry.createIsolatedInstance();
      expect(restarted.getProvider('stripe')!.isConfigured()).toBe(false);
      const report = await restarted.syncFromStore(world.store);
      expect(report).toEqual({ managementApplied: [], secretsApplied: ['stripe'], secretFailures: [] });
      expect(restarted.exportSecretsForPersistence('stripe')).toEqual([
        { field: 'api_key', label: 'Secret key', value: 'sk_test_pre_phase15' },
      ]);
      expect(restarted.getProvider('stripe')!.isConfigured()).toBe(true);
      expect(restarted.getPersistedVersions('stripe')).toEqual({ management: 0, secrets: 1 });
      expect(restarted.getPersistedVersions('nmi')).toEqual({ management: 0, secrets: 0 });
    } finally {
      pg.db = savedDb;
      await upgrade.drop();
    }
  }, 60_000);
});
