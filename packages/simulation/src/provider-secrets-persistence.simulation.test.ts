import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, dbState, installDatabaseMock } from './db';
import { decryptSecret } from '../../database/src/crypto';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway — is the REAL code (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, waitFor, type SimRuntime } from './harness';

console.warn(`\n[simulation] Provider secrets DB persistence (survives a restart)\n`);

const ADMIN_TOKEN = 'sim-admin-token';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const PROVIDER_ID = 'example-pay';

let runtime: SimRuntime;

beforeAll(async () => {
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  // Required for persistProviderSecrets()/loadAllProviderSecrets() to do
  // anything at all (see packages/database/src/provider-secrets.ts) —
  // without it, this feature no-ops by design, same as an unconfigured
  // SECRET_ENCRYPTION_KEY does in every real environment.
  process.env.SECRET_ENCRYPTION_KEY = 'sim-secret-encryption-key-0123456789';
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

function decryptConfig(providerSlug: string): unknown {
  const provider = dbState.providers.find((p) => p.slug === providerSlug);
  const config = provider && dbState.providerConfigs.find((c) => c.providerId === provider.id);
  if (!config?.encryptedSecret || !config.secretIv || !config.secretTag) return undefined;
  return JSON.parse(decryptSecret({ encrypted: config.encryptedSecret, iv: config.secretIv, tag: config.secretTag }));
}

beforeEach(() => {
  clearDb();
  // ProviderRegistry is a process-wide singleton shared across every
  // simulation test file — reset PROVIDER_ID's secrets directly through it
  // (not persistence, just in-memory cleanup) so each test here starts
  // from a known-empty state regardless of what ran before it.
  for (const secret of runtime.registry.getSecrets(PROVIDER_ID) ?? []) {
    runtime.registry.deleteSecret(PROVIDER_ID, secret.id);
  }
});

describe('POST /api/dashboard/providers/:id/secrets persists an encrypted, decryptable blob', () => {
  it('encrypts and stores the full current secrets set after adding one', async () => {
    const res = await runtime.post(
      `/api/dashboard/providers/${PROVIDER_ID}/secrets`,
      { field: 'api_key', label: 'API Key', value: 'ex_persist_test_key_123' },
      ADMIN,
    );
    expect(res.status).toBe(201);

    await waitFor(() => decryptConfig(PROVIDER_ID) !== undefined, {
      label: 'provider_configs row for example-pay',
      timeoutMs: 2000,
    });

    const provider = dbState.providers.find((p) => p.slug === PROVIDER_ID)!;
    const config = dbState.providerConfigs.find((c) => c.providerId === provider.id)!;
    // The stored blob must not contain the plaintext value anywhere —
    // proves this is actually encrypted, not just base64/JSON.
    expect(config.encryptedSecret).not.toContain('ex_persist_test_key_123');

    expect(decryptConfig(PROVIDER_ID)).toEqual([
      { field: 'api_key', label: 'API Key', value: 'ex_persist_test_key_123' },
    ]);
  });

  it('re-encrypts the full set (not an incremental diff) when a second field is added', async () => {
    await runtime.post(
      `/api/dashboard/providers/${PROVIDER_ID}/secrets`,
      { field: 'api_key', label: 'API Key', value: 'first_field_value' },
      ADMIN,
    );
    await runtime.post(
      `/api/dashboard/providers/${PROVIDER_ID}/secrets`,
      { field: 'gateway_id', label: 'Gateway ID', value: 'second_field_value' },
      ADMIN,
    );

    await waitFor(() => Array.isArray(decryptConfig(PROVIDER_ID)) && (decryptConfig(PROVIDER_ID) as unknown[]).length === 2, {
      label: 'both fields present in the persisted blob',
      timeoutMs: 2000,
    });

    expect(decryptConfig(PROVIDER_ID)).toEqual(
      expect.arrayContaining([
        { field: 'api_key', label: 'API Key', value: 'first_field_value' },
        { field: 'gateway_id', label: 'Gateway ID', value: 'second_field_value' },
      ]),
    );
  });

  it('deleting the only secret still persists (an empty, but present, encrypted set)', async () => {
    const addRes = await runtime.post(
      `/api/dashboard/providers/${PROVIDER_ID}/secrets`,
      { field: 'api_key', label: 'API Key', value: 'to_be_deleted' },
      ADMIN,
    );
    const meta = await addRes.json();

    await waitFor(() => decryptConfig(PROVIDER_ID) !== undefined, {
      label: 'provider_configs row for example-pay',
      timeoutMs: 2000,
    });

    const delRes = await runtime.request('DELETE', `/api/dashboard/providers/${PROVIDER_ID}/secrets/${meta.id}`, {
      headers: ADMIN,
    });
    expect(delRes.status).toBe(200);

    await waitFor(() => Array.isArray(decryptConfig(PROVIDER_ID)) && (decryptConfig(PROVIDER_ID) as unknown[]).length === 0, {
      label: 'persisted set reflects the deletion',
      timeoutMs: 2000,
    });
  });
});

describe('hydration reads back exactly what was persisted', () => {
  it('loadAllProviderSecrets (via the mocked module) decrypts to the same record addSecret produced', async () => {
    await runtime.post(
      `/api/dashboard/providers/${PROVIDER_ID}/secrets`,
      { field: 'api_key', label: 'API Key', value: 'round_trip_value' },
      ADMIN,
    );
    await waitFor(() => decryptConfig(PROVIDER_ID) !== undefined, {
      label: 'provider_configs row for example-pay',
      timeoutMs: 2000,
    });

    const mocked = installDatabaseMock() as {
      loadAllProviderSecrets(): Promise<Record<string, { field: string; label: string; value: string }[]>>;
    };
    const snapshot = await mocked.loadAllProviderSecrets();
    expect(snapshot[PROVIDER_ID]).toEqual([{ field: 'api_key', label: 'API Key', value: 'round_trip_value' }]);
  });
});
