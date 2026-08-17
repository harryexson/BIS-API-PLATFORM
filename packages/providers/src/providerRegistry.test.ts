import { describe, it, expect, afterEach } from 'vitest';
import { ProviderRegistry } from './index';
import { ProviderConfig } from '@company/schemas';

describe('ProviderRegistry', () => {
  afterEach(() => {
    const registry = ProviderRegistry.getInstance();
    registry.updateProviderConfig('stripe', { status: 'online' });
  });
  it('registers exactly 13 providers across the three categories', () => {
    const configs = ProviderRegistry.getInstance().getAllConfigs();
    expect(configs).toHaveLength(13);
    expect(configs.filter((c) => c.category === 'payment')).toHaveLength(6);
    expect(configs.filter((c) => c.category === 'messaging')).toHaveLength(4);
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