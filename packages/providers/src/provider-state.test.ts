import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ProviderRegistry,
  ProviderStateSync,
  ProviderStateConflictError,
  type PersistableProviderManagement,
  type PersistableProviderSecret,
  type ProviderStateStore,
} from './index';

/**
 * Phase 15 unit coverage for packages/providers' side of gap register
 * A14 (circuit breaker), D13 (secret masking / never-silent persistence) and
 * E12 (persisted provider state). Every test uses its own isolated registry,
 * so no state leaks into the shared singleton other suites use.
 */

/** Minimal in-memory ProviderStateStore with the same compare-and-set contract as the Postgres one. */
function memoryStore() {
  const rows = new Map<string, { mv: number; m: unknown; sv: number; s: PersistableProviderSecret[] }>();
  const row = (slug: string) => rows.get(slug) ?? { mv: 0, m: null, sv: 0, s: [] };
  const store: ProviderStateStore & { rows: typeof rows } = {
    rows,
    async loadAll() {
      return [...rows.keys()].map((slug) => (store.load(slug) as unknown) as never);
    },
    async load(slug) {
      if (!rows.has(slug)) return null;
      const r = row(slug);
      return { slug, managementVersion: r.mv, management: structuredClone(r.m), secretsVersion: r.sv, readSecrets: () => structuredClone(r.s) };
    },
    async saveManagement({ slug, management, expectedVersion }) {
      const r = row(slug);
      if (r.mv !== expectedVersion) return { saved: false };
      rows.set(slug, { ...r, mv: r.mv + 1, m: structuredClone(management) });
      return { saved: true, version: r.mv + 1 };
    },
    async saveSecrets({ slug, secrets, expectedVersion }) {
      const r = row(slug);
      if (r.sv !== expectedVersion) return { saved: false };
      rows.set(slug, { ...r, sv: r.sv + 1, s: structuredClone(secrets) });
      return { saved: true, version: r.sv + 1 };
    },
  };
  // loadAll must resolve the per-slug promises.
  store.loadAll = async () => Promise.all([...rows.keys()].map((slug) => store.load(slug))) as never;
  return store;
}

const COOLDOWN_MS = 30_000;

function tripCircuit(registry: ProviderRegistry, id: string): void {
  for (let i = 0; i < 5; i++) registry.recordTraffic(id, false, 100);
  expect(registry.getManagementView(id)!.circuitState).toBe('open');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('A14b — checking circuit availability never mutates breaker state', () => {
  it('an OPEN circuit past its cooldown stays OPEN no matter how often availability is checked', () => {
    vi.useFakeTimers();
    const registry = ProviderRegistry.createIsolatedInstance();
    tripCircuit(registry, 'stripe');
    vi.advanceTimersByTime(COOLDOWN_MS + 1);

    // Eligible as the recovery-probe candidate...
    expect(registry.isCircuitAvailable('stripe')).toBe(true);
    expect(registry.isProviderAvailable('stripe')).toBe(true);
    registry.findByCategoryAndCapabilities('payment', ['card'], 'USD');
    registry.findByCategoryAndCapabilities('payment', ['card'], 'USD');
    // ...but merely being looked at did not start a probe.
    expect(registry.getManagementView('stripe')!.circuitState).toBe('open');
  });
});

describe('A14a — HALF_OPEN admits exactly one recovery probe', () => {
  it('only the first dispatch after the cooldown is admitted; others are refused until the probe resolves', () => {
    vi.useFakeTimers();
    const registry = ProviderRegistry.createIsolatedInstance();
    tripCircuit(registry, 'stripe');
    expect(registry.tryAcquireDispatch('stripe')).toBe(false); // still cooling down

    vi.advanceTimersByTime(COOLDOWN_MS + 1);
    expect(registry.tryAcquireDispatch('stripe')).toBe(true);
    expect(registry.getManagementView('stripe')!.circuitState).toBe('half_open');
    expect(registry.tryAcquireDispatch('stripe')).toBe(false);
    expect(registry.tryAcquireDispatch('stripe')).toBe(false);
    expect(registry.isProviderAvailable('stripe')).toBe(false);

    registry.recordTraffic('stripe', true, 80);
    expect(registry.getManagementView('stripe')!.circuitState).toBe('closed');
    expect(registry.tryAcquireDispatch('stripe')).toBe(true);
    expect(registry.tryAcquireDispatch('stripe')).toBe(true);
  });

  it('a failed probe re-opens the circuit; a released (definite pre-send) probe frees the slot; an abandoned probe expires', () => {
    vi.useFakeTimers();
    const registry = ProviderRegistry.createIsolatedInstance();
    tripCircuit(registry, 'nmi');
    vi.advanceTimersByTime(COOLDOWN_MS + 1);

    expect(registry.tryAcquireDispatch('nmi')).toBe(true);
    registry.recordTraffic('nmi', false, 0);
    expect(registry.getManagementView('nmi')!.circuitState).toBe('open');
    expect(registry.tryAcquireDispatch('nmi')).toBe(false);

    vi.advanceTimersByTime(COOLDOWN_MS + 1);
    expect(registry.tryAcquireDispatch('nmi')).toBe(true);
    registry.releaseDispatch('nmi');
    expect(registry.tryAcquireDispatch('nmi')).toBe(true); // slot handed back
    expect(registry.tryAcquireDispatch('nmi')).toBe(false);

    vi.advanceTimersByTime(COOLDOWN_MS + 1); // that probe was never resolved
    expect(registry.tryAcquireDispatch('nmi')).toBe(true);
  });
});

describe('D13 — secret masking never reveals more than a short fixed prefix', () => {
  it.each([
    ['sk_test_123', 'sk••••••••'],
    ['abcd', 'a••••••••'],
    ['abc', '••••••••'],
    ['x', '••••••••'],
    ['0123456789', '01••••••••'],
    ['fixture-key-prefix-VeryLongSecretValue000000000000', 'fixt••••••••'],
  ])('%s → %s', (raw, masked) => {
    expect(ProviderRegistry.maskSecret(raw)).toBe(masked);
  });

  it('never shows the tail, and never shows a short secret in full (through addSecret too)', () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    for (const value of ['sk_test_123', 'pass', 'abcdefghij', 'tok_live_9f8e7d6c5b4a']) {
      const meta = registry.addSecret('example-msg', { field: `f_${value.length}`, label: 'probe', value })!;
      const visible = meta.masked.replace(/•/g, '');
      expect(visible.length).toBeLessThanOrEqual(4);
      expect(visible.length).toBeLessThanOrEqual(Math.floor(value.length / 4));
      expect(meta.masked).not.toContain(value.slice(-4));
      expect(meta.masked).not.toContain(value);
    }
  });
});

describe('E12 — writes go through the store, and a failed or lost write changes nothing', () => {
  it('a store failure rolls the local change back and is rethrown (never reported as applied)', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const store = memoryStore();
    store.saveManagement = async () => {
      throw new Error('database unreachable');
    };
    const before = registry.exportManagementForPersistence('square');

    await expect(
      registry.mutatePersisted(store, 'square', 'management', () => registry.updateManagement('square', { currencies: ['JPY'], status: 'offline' })),
    ).rejects.toThrow('database unreachable');
    expect(registry.exportManagementForPersistence('square')).toEqual(before);
    expect(registry.getPersistedVersions('square')).toEqual({ management: 0, secrets: 0 });
  });

  it('a secret write the store refuses (e.g. no encryption key) leaves no secret behind', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const store = memoryStore();
    store.saveSecrets = async () => {
      throw new Error('SECRET_ENCRYPTION_KEY is not configured');
    };
    await expect(
      registry.mutatePersisted(store, 'stripe', 'secrets', () => registry.addSecret('stripe', { field: 'api_key', label: 'k', value: 'sk_x_unsaved' })),
    ).rejects.toThrow('SECRET_ENCRYPTION_KEY');
    expect(registry.getSecrets('stripe')).toEqual([]);
    expect(registry.exportSecretsForPersistence('stripe')).toEqual([]);
  });

  it('a writer that keeps losing the compare-and-set gets ProviderStateConflictError and its change is rolled back', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const store = memoryStore();
    store.saveManagement = async () => ({ saved: false });
    const before = registry.exportManagementForPersistence('paystack');
    await expect(
      registry.mutatePersisted(store, 'paystack', 'management', () => registry.updateManagement('paystack', { priority: 3 })),
    ).rejects.toBeInstanceOf(ProviderStateConflictError);
    expect(registry.exportManagementForPersistence('paystack')).toEqual(before);
  });

  it('a "not found" mutation writes nothing', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const store = memoryStore();
    expect(await registry.mutatePersisted(store, 'stripe', 'management', () => registry.updateRoutingRule('stripe', 'rule_nope', { enabled: false }))).toBeNull();
    expect(await registry.mutatePersisted(store, 'ghost', 'management', () => ({}))).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it('two replicas: a write through one is applied by the other on sync; versions only move forward', async () => {
    const store = memoryStore();
    const a = ProviderRegistry.createIsolatedInstance();
    const b = ProviderRegistry.createIsolatedInstance();
    await a.mutatePersisted(store, 'stripe', 'management', () => a.updateManagement('stripe', { currencies: ['USD', 'CHF'] }));
    await a.mutatePersisted(store, 'stripe', 'secrets', () => a.addSecret('stripe', { field: 'api_key', label: 'k', value: 'sk_test_shared' }));

    const report = await b.syncFromStore(store);
    expect(report).toEqual({ managementApplied: ['stripe'], secretsApplied: ['stripe'], secretFailures: [] });
    expect(b.getManagementView('stripe')!.currencies).toEqual(['USD', 'CHF']);
    expect(b.getSecrets('stripe')).toEqual(a.getSecrets('stripe'));
    expect(b.getProvider('stripe')!.isConfigured()).toBe(true);

    // Re-syncing an unchanged store applies nothing.
    expect(await b.syncFromStore(store)).toEqual({ managementApplied: [], secretsApplied: [], secretFailures: [] });
  });

  it('a persisted document with malformed fields keeps the current values for those fields', async () => {
    const store = memoryStore();
    const registry = ProviderRegistry.createIsolatedInstance();
    const before = registry.exportManagementForPersistence('stripe')!;
    store.rows.set('stripe', {
      mv: 1,
      m: { ...before, currencies: 'USD', priority: 'high', status: 'exploded', countries: ['GB'] } as unknown as PersistableProviderManagement,
      sv: 0,
      s: [],
    });
    await registry.syncFromStore(store);
    const after = registry.exportManagementForPersistence('stripe')!;
    expect(after.currencies).toEqual(before.currencies);
    expect(after.priority).toBe(before.priority);
    expect(after.status).toBe(before.status);
    expect(after.countries).toEqual(['GB']);
  });

  it('undecryptable persisted secrets are reported once per version and withhold the provider until a readable version arrives', async () => {
    const store = memoryStore();
    const registry = ProviderRegistry.createIsolatedInstance();
    store.rows.set('nmi', { mv: 0, m: null, sv: 1, s: [] });
    const realLoad = store.load.bind(store);
    store.load = async (slug) => {
      const r = await realLoad(slug);
      if (r && slug === 'nmi' && r.secretsVersion === 1) r.readSecrets = () => { throw new Error('Unsupported state or unable to authenticate data'); };
      return r;
    };
    const first = await registry.syncFromStore(store);
    expect(first.secretFailures).toEqual([{ slug: 'nmi', version: 1, error: 'Unsupported state or unable to authenticate data' }]);
    expect(registry.isProviderAvailable('nmi')).toBe(false);
    expect((await registry.syncFromStore(store)).secretFailures).toEqual([]); // not re-reported...
    expect(registry.getSecretLoadFailures().map((f) => f.slug)).toEqual(['nmi']); // ...but still withheld
    await expect(
      registry.mutatePersisted(store, 'nmi', 'secrets', () => registry.addSecret('nmi', { field: 'api_key', label: 'k', value: 'v' })),
    ).rejects.toThrow(/refusing to overwrite/);

    store.rows.set('nmi', { mv: 0, m: null, sv: 2, s: [{ field: 'api_key', label: 'k', value: 'nmi_ok' }] });
    expect((await registry.syncFromStore(store)).secretsApplied).toEqual(['nmi']);
    expect(registry.isProviderAvailable('nmi')).toBe(true);
  });
});

describe('E12 — ProviderStateSync (startup load is awaited and never rejects)', () => {
  it('initialLoad resolves after the store has been applied', async () => {
    const store = memoryStore();
    const writer = ProviderRegistry.createIsolatedInstance();
    await writer.mutatePersisted(store, 'stripe', 'management', () => writer.updateManagement('stripe', { priority: 12 }));
    const registry = ProviderRegistry.createIsolatedInstance();
    const sync = new ProviderStateSync(registry, store);
    await sync.initialLoad;
    expect(sync.status().loaded).toBe(true);
    expect(registry.getManagementView('stripe')!.priority).toBe(12);
  });

  it('a failing store resolves initialLoad with loaded=false and reports the error', async () => {
    const store = memoryStore();
    store.loadAll = async () => {
      throw new Error('connection refused');
    };
    const errors: unknown[] = [];
    const sync = new ProviderStateSync(ProviderRegistry.createIsolatedInstance(), store, { onError: (e) => errors.push(e) });
    await expect(sync.initialLoad).resolves.toBeUndefined();
    expect(sync.status()).toMatchObject({ loaded: false, lastError: 'connection refused' });
    expect(errors).toHaveLength(1);
  });
});
