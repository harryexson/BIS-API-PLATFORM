import { describe, it, expect, afterEach } from 'vitest';
import { ProviderRegistry } from './index';
import { ProviderConfig } from '@company/schemas';

describe('ProviderRegistry', () => {
  afterEach(() => {
    const registry = ProviderRegistry.getInstance();
    registry.updateProviderConfig('stripe', { status: 'online' });
  });
  it('registers exactly 15 providers across the three categories (13 original + 2 examples)', () => {
    const configs = ProviderRegistry.getInstance().getAllConfigs();
    expect(configs).toHaveLength(15);
    expect(configs.filter((c) => c.category === 'payment')).toHaveLength(7);
    expect(configs.filter((c) => c.category === 'messaging')).toHaveLength(5);
    expect(configs.filter((c) => c.category === 'other')).toHaveLength(3);
  });

  it('has unique provider ids', () => {
    const ids = ProviderRegistry.getInstance().getAllConfigs().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('enforces valid weight and latency invariants on every config', () => {
    for (const config of ProviderRegistry.getInstance().getAllConfigs()) {
      expect(config.weight).toBeGreaterThanOrEqual(0);
      expect(config.latencyMin).toBeGreaterThan(0);
      expect(config.latencyMax).toBeGreaterThanOrEqual(config.latencyMin);
    }
  });

  it('does not throw during registry construction (all adapters load statically)', () => {
    expect(() => ProviderRegistry.getInstance()).not.toThrow();
  });

  it('updateProviderConfig applies changes and returns the config', () => {
    const registry = ProviderRegistry.getInstance();
    const updated = registry.updateProviderConfig('stripe', { status: 'maintenance' });
    expect(updated).not.toBeNull();
    expect((updated as ProviderConfig).status).toBe('maintenance');
  });

  it('updateProviderConfig returns null for an unknown provider', () => {
    expect(ProviderRegistry.getInstance().updateProviderConfig('ghost', { status: 'offline' })).toBeNull();
  });
});

describe('ProviderRegistry management surface', () => {
  const registry = ProviderRegistry.getInstance();

  it('returns a management view with required management fields', () => {
    const view = registry.getManagementView('stripe');
    expect(view).not.toBeNull();
    expect(view!.environment).toBeDefined();
    expect(Array.isArray(view!.countries)).toBe(true);
    expect(Array.isArray(view!.currencies)).toBe(true);
    expect(Array.isArray(view!.capabilities)).toBe(true);
    expect(typeof view!.priority).toBe('number');
    expect(view!.health).toBeDefined();
    expect(Array.isArray(view!.routingRules)).toBe(true);
  });

  it('updates management fields via updateManagement', () => {
    const updated = registry.updateManagement('stripe', { environment: 'test', errorRate: 12 });
    expect(updated!.environment).toBe('test');
    expect(updated!.errorRate).toBe(12);
    registry.updateManagement('stripe', { environment: 'live', errorRate: 0 });
  });

  it('returns null from getManagementView for an unknown provider', () => {
    expect(registry.getManagementView('ghost')).toBeNull();
  });

  it('adds, lists and deletes a secret (metadata only)', () => {
    const meta = registry.addSecret('stripe', { label: 'Live Key', value: 'sk_live_abcdef123456' });
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('Live Key');
    expect(meta!.masked).not.toContain('abcdef123456');
    expect(meta!.masked).toContain('••••');

    const list = registry.getSecrets('stripe');
    expect(list!.some(s => s.id === meta!.id)).toBe(true);

    expect(registry.deleteSecret('stripe', meta!.id)).toBe(true);
    expect(registry.getSecrets('stripe')!.some(s => s.id === meta!.id)).toBe(false);
  });

  it('adds, updates and deletes routing rules', () => {
    const rule = registry.addRoutingRule('stripe', { match: 'currency == MWK', target: 'pawapay', enabled: true });
    expect(rule!.id).toBeDefined();
    expect(rule!.enabled).toBe(true);

    const updated = registry.updateRoutingRule('stripe', rule!.id, { enabled: false });
    expect(updated!.enabled).toBe(false);

    expect(registry.deleteRoutingRule('stripe', rule!.id)).toBe(true);
    expect(registry.getRoutingRules('stripe')!.some(r => r.id === rule!.id)).toBe(false);
  });

  it('runs a health check returning a summary', async () => {
    const summary = await registry.runHealthCheck('stripe');
    expect(summary).not.toBeNull();
    expect(summary!.providerId).toBe('stripe');
    expect(['healthy', 'degraded', 'down', 'unknown']).toContain(summary!.status);
    expect(typeof summary!.latencyMs).toBe('number');
    expect(typeof summary!.checkedAt).toBe('string');
  });

  it('runs health checks for all providers', async () => {
    const summaries = await registry.runHealthChecks();
    expect(summaries.length).toBe(15);
  });
});

describe('Provider Addition Dry Run (Phase 16)', () => {
  const registry = ProviderRegistry.getInstance();

  it('new ExamplePaymentProvider is found by capability-based routing', () => {
    const matches = registry.findByCategoryAndCapabilities('payment', ['card'], 'USD');
    const ids = matches.map(m => m.id);
    expect(ids).toContain('example-pay');
  });

  it('new ExampleMessagingProvider is found by capability-based routing for SMS', () => {
    const matches = registry.findByCategoryAndCapabilities('messaging', ['sms']);
    const ids = matches.map(m => m.id);
    expect(ids).toContain('example-msg');
  });

  it('new ExampleMessagingProvider is found by capability-based routing for email', () => {
    const matches = registry.findByCategoryAndCapabilities('messaging', ['email']);
    const ids = matches.map(m => m.id);
    expect(ids).toContain('example-msg');
  });

  it('new providers return management views', () => {
    const payView = registry.getManagementView('example-pay');
    expect(payView).not.toBeNull();
    expect(payView!.name).toBe('Example Payment Gateway');
    expect(payView!.capabilities).toContain('card');

    const msgView = registry.getManagementView('example-msg');
    expect(msgView).not.toBeNull();
    expect(msgView!.name).toBe('Example Messaging Gateway');
    expect(msgView!.capabilities).toContain('sms');
  });

  it('new providers support secrets management', () => {
    const meta = registry.addSecret('example-pay', { label: 'API Key', value: 'ex_test_key_12345' });
    expect(meta).not.toBeNull();
    expect(meta!.masked).toContain('••••');

    const secrets = registry.getSecrets('example-pay');
    expect(secrets!.some(s => s.id === meta!.id)).toBe(true);

    expect(registry.deleteSecret('example-pay', meta!.id)).toBe(true);
  });
});
