import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Phase 25 — SECRET_ENCRYPTION_KEY lost, recovery attempted the way
 * DISASTER_RECOVERY.md §4.2 described it BEFORE this phase ("generate a new
 * key, set it, re-enter every credential via the admin dashboard"), through
 * the REAL gateway routes, a named Phase 20-21 admin credential and a REAL
 * PostgreSQL migrated from zero. The only substitution is connection.ts's
 * getDb() (postgres-js instead of neon-http, same SQL).
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/secret-key-loss-unrecovered.postgres.integration.test.ts
 *
 * Re-entering a credential is REFUSED (503) while the old-key ciphertext is
 * still in provider_configs: since Phase 15 (gap register D13 fix (a)) the
 * registry never overwrites persisted secrets it cannot decrypt, and there is
 * no admin route that discards them (PHASE15-04). Clearing the rows with SQL
 * while the process keeps running does not help either — the instance must
 * be restarted after the rows are cleared. The order that works is proven in
 * secret-key-loss-recovery.postgres.integration.test.ts.
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

describe.skipIf(!ADMIN_URL)('Phase 25 — SECRET_ENCRYPTION_KEY lost: the pre-Phase-25 runbook procedure (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  const admin = { 'x-admin-token': ADMIN_TOKEN };
  const rowState = async (slug: string) =>
    (await database.client`SELECT c.secrets_version, c.encrypted_secret FROM provider_configs c
                           JOIN providers p ON p.id = c.provider_id WHERE p.slug = ${slug}`)[0];

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p25kl');
    pg.db = database.db;
    const { providerStateStore } = await import('@company/database');

    // Credentials an admin stored while the old key was in force.
    process.env.SECRET_ENCRYPTION_KEY = OLD_KEY;
    await seedProviderSecrets(providerStateStore);

    // Runbook steps 1-2 (old text): a new key, set, service redeployed.
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

  it('the redeployed gateway cannot decrypt the old rows: /ready reports providers "degraded" (503) and the providers are withheld from routing', async () => {
    const res = await runtime.get('/ready');
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.dependencies.providers).toBe('degraded');
    expect(body.failing).toContain('providers');
    expect(runtime.registry.isProviderAvailable('stripe')).toBe(false);
    expect(runtime.registry.isProviderAvailable('nmi')).toBe(false);
    expect(runtime.registry.getSecretLoadFailures().map((f) => f.slug).sort()).toEqual(['nmi', 'stripe']);
  });

  it('runbook step 3 (old text) "re-enter every provider credential via the admin dashboard" is refused with 503 and changes nothing', async () => {
    const before = await rowState('stripe');
    const res = await runtime.post(
      '/api/dashboard/providers/stripe/secrets',
      { field: 'api_key', label: 'Secret key', value: 'sk_test_p25_reentered' },
      admin,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('provider_state_persist_failed');
    expect(body.error).toMatch(/cannot be decrypted .* refusing to overwrite them/);
    expect(await rowState('stripe')).toEqual(before);
    // Nothing to address for a DELETE either: the undecryptable set was never loaded.
    const list = await (await runtime.get('/api/dashboard/providers/stripe/secrets', admin)).json();
    expect(list).toEqual([]);
  });

  it('the refused recovery attempt is audited under the named admin identity', async () => {
    let rows: Array<{ actor_id: string; status_code: number }> = [];
    await waitFor(async () => {
      rows = await database.client`SELECT actor_id, status_code FROM audit_logs
                                   WHERE action = 'POST /api/dashboard/providers/:id/secrets' AND status_code = 503`;
      return rows.length > 0;
    }, { label: 'refused secret write audited' });
    expect(rows[0]).toEqual({ actor_id: ONCALL_ADMIN_ID, status_code: 503 });
  });

  it('clearing the undecryptable rows with SQL while this instance keeps running is NOT enough: it still refuses until restarted', async () => {
    await database.client.unsafe(clearUndecryptableSecretsSql('test'));
    expect(await rowState('nmi')).toEqual({ secrets_version: 0, encrypted_secret: null });
    const res = await runtime.post('/api/dashboard/providers/nmi/secrets', { field: 'api_key', label: 'API key', value: 'nmi_p25_reentered' }, admin);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/refusing to overwrite them/);
    expect(await rowState('nmi')).toEqual({ secrets_version: 0, encrypted_secret: null });
  });
});
