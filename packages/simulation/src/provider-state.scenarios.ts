import { it, expect } from 'vitest';
import { ProviderRegistry, type ProviderStateStore } from '@company/providers';
import type { SimRuntime } from './harness';

/**
 * Phase 15 — provider registry persistence + secret handling (gap register
 * E12, D13, C9), driven through the REAL gateway's admin and API routes.
 * Registered twice: against the simulation database double
 * (provider-state.simulation.test.ts) and against a REAL PostgreSQL
 * database migrated from zero (provider-state.postgres.integration.test.ts),
 * where every compare-and-set is Postgres's own single statement.
 *
 * "Another replica" / "a restarted process" is a fresh
 * ProviderRegistry.createIsolatedInstance() — an independent in-memory
 * registry that knows nothing until it loads from the same store.
 * Each scenario uses its own provider so state never leaks between them.
 */
export interface ProviderStateWorld {
  runtime: SimRuntime;
  adminToken: string;
  tenantId: string;
  /** An API key of the TEST tier ('test' / 'development'). */
  testTierKey: string;
  /** An API key of the LIVE tier ('live' / 'production'). */
  liveTierKey: string;
  /** @company/database's providerStateStore, bound to this world's database. */
  store: ProviderStateStore;
  /** The gateway module's test hook: re-sync now instead of waiting for the refresh interval. */
  syncGateway(): Promise<void>;
}

export function registerProviderStateScenarios(getWorld: () => ProviderStateWorld): void {
  const admin = () => ({ 'x-admin-token': getWorld().adminToken });
  const patch = (path: string, body: unknown) =>
    getWorld().runtime.request('PATCH', path, {
      headers: { 'content-type': 'application/json', ...admin() },
      body: JSON.stringify(body),
    });

  async function freshReplica(): Promise<ProviderRegistry> {
    const replica = ProviderRegistry.createIsolatedInstance();
    const report = await replica.syncFromStore(getWorld().store);
    expect(report.secretFailures).toEqual([]);
    return replica;
  }

  it('E12: admin configuration changes are persisted — a restarted process / new replica loads them instead of code defaults', async () => {
    const before = ProviderRegistry.createIsolatedInstance().getManagementView('square')!;
    expect(before.currencies).not.toContain('JPY');

    const res = await patch('/api/dashboard/providers/square/management', {
      currencies: ['USD', 'JPY'],
      countries: ['US', 'JP'],
      priority: 77,
    });
    expect(res.status).toBe(200);
    const ruleRes = await getWorld().runtime.post(
      '/api/dashboard/providers/square/routing',
      { match: 'currency == JPY', target: 'square', description: 'p15 restart probe' },
      admin(),
    );
    expect(ruleRes.status).toBe(201);
    const rule = await ruleRes.json();

    const persisted = await getWorld().store.load('square');
    expect(persisted?.managementVersion).toBe(2);

    const replica = await freshReplica();
    const view = replica.getManagementView('square')!;
    expect(view.currencies).toEqual(['USD', 'JPY']);
    expect(view.countries).toEqual(['US', 'JP']);
    expect(view.priority).toBe(77);
    expect(view.weight).toBe(77);
    expect(view.routingRules.map((r) => r.id)).toEqual([rule.id]);
    expect(replica.getEnabledRoutingRules().some((r) => r.id === rule.id)).toBe(true);
    expect(replica.getPersistedVersions('square')).toEqual({ management: 2, secrets: 0 });
  });

  it('E12: a change written through one replica reaches every other replica (and the gateway) on its next sync', async () => {
    const replicaB = await freshReplica();
    expect(getWorld().runtime.registry.isProviderAvailable('checkout')).toBe(true);

    const updated = await replicaB.mutatePersisted(getWorld().store, 'checkout', 'management', () =>
      replicaB.updateManagement('checkout', { status: 'offline' }),
    );
    expect(updated?.status).toBe('offline');

    // The gateway has not synced yet: still the old view (bounded staleness).
    expect(getWorld().runtime.registry.getProvider('checkout')!.config.status).toBe('online');
    await getWorld().syncGateway();
    expect(getWorld().runtime.registry.getProvider('checkout')!.config.status).toBe('offline');
    expect(getWorld().runtime.registry.isProviderAvailable('checkout')).toBe(false);

    // ...and an admin change through the gateway reaches replica B.
    const back = await patch('/api/dashboard/providers/checkout', { status: 'online' });
    expect(back.status).toBe(200);
    await replicaB.syncFromStore(getWorld().store);
    expect(replicaB.getProvider('checkout')!.config.status).toBe('online');
  });

  it('E12: concurrent writes from two stale replicas never lose an update (compare-and-set + retry)', async () => {
    const a = await freshReplica();
    const b = await freshReplica();
    const start = a.getPersistedVersions('paystack')!.management;
    expect(b.getPersistedVersions('paystack')!.management).toBe(start);

    await a.mutatePersisted(getWorld().store, 'paystack', 'management', () =>
      a.updateManagement('paystack', { currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'] }),
    );
    // b still holds the old version and old currencies; its write must not clobber a's.
    expect(b.getManagementView('paystack')!.currencies).not.toContain('USD');
    await b.mutatePersisted(getWorld().store, 'paystack', 'management', () =>
      b.updateManagement('paystack', { priority: 61 }),
    );

    const row = await getWorld().store.load('paystack');
    expect(row!.managementVersion).toBe(start + 2);
    const doc = row!.management as { currencies: string[]; priority: number };
    expect(doc.currencies).toContain('USD');
    expect(doc.priority).toBe(61);
    expect(b.getManagementView('paystack')!.currencies).toContain('USD');
  });

  it('D13: with SECRET_ENCRYPTION_KEY unset, a secret write is refused (503) and nothing changes anywhere — never a silent no-op', async () => {
    const saved = process.env.SECRET_ENCRYPTION_KEY;
    delete process.env.SECRET_ENCRYPTION_KEY;
    try {
      const res = await getWorld().runtime.post(
        '/api/dashboard/providers/braintree/secrets',
        { field: 'private_key', label: 'Private key', value: 'bt_p15_unpersisted_secret' },
        admin(),
      );
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('secret_encryption_key_missing');
    } finally {
      process.env.SECRET_ENCRYPTION_KEY = saved;
    }
    const list = await (await getWorld().runtime.get('/api/dashboard/providers/braintree/secrets', admin())).json();
    expect(list.map((s: { field: string }) => s.field)).not.toContain('private_key');
    expect(getWorld().runtime.registry.exportSecretsForPersistence('braintree')).toEqual([]);
    expect((await getWorld().store.load('braintree'))?.secretsVersion ?? 0).toBe(0);
  });

  it('secrets written through the gateway are persisted before the 201 and converge on other replicas (same id, masked)', async () => {
    const res = await getWorld().runtime.post(
      '/api/dashboard/providers/authorizenet/secrets',
      { field: 'api_login_id', label: 'API login id', value: 'anet_p15_login_value' },
      admin(),
    );
    expect(res.status).toBe(201);
    const meta = await res.json();
    expect(meta.masked).toBe('anet••••••••');

    const replica = await freshReplica();
    expect(replica.getSecrets('authorizenet')).toEqual([meta]);
    expect(replica.exportSecretsForPersistence('authorizenet')).toEqual([
      { field: 'api_login_id', label: 'API login id', value: 'anet_p15_login_value' },
    ]);

    const del = await getWorld().runtime.request('DELETE', `/api/dashboard/providers/authorizenet/secrets/${meta.id}`, { headers: admin() });
    expect(del.status).toBe(200);
    await replica.syncFromStore(getWorld().store);
    expect(replica.getSecrets('authorizenet')).toEqual([]);
  });

  it('D13: persisted secrets that cannot be decrypted are reported and the provider is withheld from routing — not silently skipped', async () => {
    const goodKey = process.env.SECRET_ENCRYPTION_KEY;
    const store = getWorld().store;
    const current = (await store.load('vonage'))?.secretsVersion ?? 0;
    // Written under a different key (e.g. SECRET_ENCRYPTION_KEY changed since).
    process.env.SECRET_ENCRYPTION_KEY = 'p15-some-other-encryption-key-0123456789';
    try {
      const write = await store.saveSecrets({
        slug: 'vonage', name: 'Vonage', category: 'messaging',
        secrets: [{ field: 'api_key', label: 'API key', value: 'vonage_p15' }],
        expectedVersion: current,
      });
      expect(write.saved).toBe(true);
    } finally {
      process.env.SECRET_ENCRYPTION_KEY = goodKey;
    }

    const replica = ProviderRegistry.createIsolatedInstance();
    const report = await replica.syncFromStore(store);
    expect(report.secretFailures.map((f) => f.slug)).toEqual(['vonage']);
    expect(report.secretFailures[0].error).toMatch(/could not be decrypted/);
    expect(replica.isProviderAvailable('vonage')).toBe(false);

    await getWorld().syncGateway();
    expect(getWorld().runtime.registry.isProviderAvailable('vonage')).toBe(false);
    const ready = await getWorld().runtime.get('/ready');
    expect((await ready.json()).dependencies.providers).toBe('degraded');
    expect(ready.status).toBe(503);

    // Recovery: a version that decrypts under the configured key clears it.
    const fixed = await store.saveSecrets({
      slug: 'vonage', name: 'Vonage', category: 'messaging',
      secrets: [], expectedVersion: current + 1,
    });
    expect(fixed.saved).toBe(true);
    await getWorld().syncGateway();
    expect(getWorld().runtime.registry.isProviderAvailable('vonage')).toBe(true);
    expect(getWorld().runtime.registry.getSecretLoadFailures()).toEqual([]);
  });

  it('C9: a production deployment refuses a test-tier API key (and a non-production one refuses a live-tier key)', async () => {
    const { runtime, tenantId, testTierKey, liveTierKey } = getWorld();
    const call = (key: string) =>
      runtime.get('/v1/api/gateway/providers', { authorization: `Bearer ${key}`, 'x-tenant-id': tenantId });
    const savedEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const testInProd = await call(testTierKey);
      expect(testInProd.status).toBe(401);
      expect((await testInProd.json()).error).toBe('API key is not valid for "live" environment');
      expect((await call(liveTierKey)).status).toBe(200);

      process.env.NODE_ENV = 'test';
      expect((await call(testTierKey)).status).toBe(200);
      const liveInTest = await call(liveTierKey);
      expect(liveInTest.status).toBe(401);
      expect((await liveInTest.json()).error).toBe('API key is not valid for "test" environment');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
}
