import { describe, it, expect, afterEach } from 'vitest';
import { ProviderRegistry } from './index';

describe('ProviderRegistry management surface', () => {
  const registry = ProviderRegistry.getInstance();

  afterEach(() => {
    registry.updateManagement('stripe', { status: 'online', priority: 70 });
  });

  it('exposes management views for all providers with required fields', () => {
    const views = registry.getAllManagementViews();
    expect(views).toHaveLength(13);
    for (const v of views) {
      expect(v).toHaveProperty('environment');
      expect(v).toHaveProperty('countries');
      expect(v).toHaveProperty('currencies');
      expect(v).toHaveProperty('capabilities');
      expect(v).toHaveProperty('priority');
      expect(v).toHaveProperty('health');
      expect(v).toHaveProperty('errorRate');
      expect(v).toHaveProperty('routingRules');
      expect(Array.isArray(v.countries)).toBe(true);
      expect(Array.isArray(v.routingRules)).toBe(true);
    }
  });

  it('seeds a masked secret per provider and never exposes the plaintext', () => {
    const secrets = registry.getSecrets('stripe');
    expect(secrets).not.toBeNull();
    expect(secrets!.length).toBeGreaterThan(0);
    for (const s of secrets!) {
      expect(s).not.toHaveProperty('value');
      expect(s.masked).toContain('•');
    }
  });

  it('addSecret returns only masked metadata', () => {
    const meta = registry.addSecret('stripe', { label: 'Test Key', value: 'super-secret-value' });
    expect(meta).not.toBeNull();
    expect(meta!.masked).toContain('•');
    expect((meta as any).value).toBeUndefined();
  });

  it('syncs priority changes to the underlying routing weight', () => {
    const updated = registry.updateManagement('stripe', { priority: 88 });
    expect(updated!.priority).toBe(88);
    expect(registry.getProvider('stripe')!.config.weight).toBe(88);
  });

  it('runHealthCheck reports healthy for an online provider and stamps last success', async () => {
    const summary = await registry.runHealthCheck('stripe');
    expect(summary).not.toBeNull();
    expect(summary!.status).toBe('healthy');
    expect(summary!.latencyMs).toBeGreaterThanOrEqual(0);
    const view = registry.getManagementView('stripe')!;
    expect(view.health).toBe('healthy');
    expect(view.lastSuccessfulRequest).not.toBeNull();
  });

  it('runHealthCheck reports down for an offline provider', async () => {
    registry.updateManagement('stripe', { status: 'offline' });
    const summary = await registry.runHealthCheck('stripe');
    expect(summary!.status).toBe('down');
  });

  it('manages routing rules', () => {
    const rule = registry.addRoutingRule('stripe', {
      match: 'currency == USD',
      target: 'stripe',
      enabled: true,
    });
    expect(rule).not.toBeNull();
    expect(rule!.id).toBeDefined();

    const updated = registry.updateRoutingRule('stripe', rule!.id, { enabled: false });
    expect(updated!.enabled).toBe(false);

    expect(registry.getRoutingRules('stripe')!.length).toBe(1);
    expect(registry.deleteRoutingRule('stripe', rule!.id)).toBe(true);
    expect(registry.getRoutingRules('stripe')!.length).toBe(0);
  });

  it('recordTraffic updates error rate and last successful request', () => {
    registry.updateManagement('nmi', { errorRate: 0, lastSuccessfulRequest: null });
    registry.recordTraffic('nmi', true, 150);
    expect(registry.getManagementView('nmi')!.lastSuccessfulRequest).not.toBeNull();

    registry.recordTraffic('nmi', false, 150);
    expect(registry.getManagementView('nmi')!.errorRate).toBeGreaterThan(0);
  });

  it('returns null for unknown providers', () => {
    expect(registry.getManagementView('ghost')).toBeNull();
    expect(registry.updateManagement('ghost', { priority: 1 })).toBeNull();
    expect(registry.getSecrets('ghost')).toBeNull();
  });
});
