import { describe, it, expect, afterEach, vi } from 'vitest';
import { ProviderRegistry } from './index';

// Default tuning from registry.ts (CIRCUIT_BREAKER_FAILURE_THRESHOLD=5,
// CIRCUIT_BREAKER_COOLDOWN_MS=30_000) when no env override is set.
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

describe('ProviderRegistry — circuit breaker', () => {
  const registry = ProviderRegistry.getInstance();

  afterEach(() => {
    // Reset via the same path production code uses to bring a provider
    // back online, so no circuit-breaker state leaks between tests.
    registry.updateProviderConfig('stripe', { status: 'online' });
    vi.useRealTimers();
  });

  it('starts closed and available', () => {
    expect(registry.getManagementView('stripe')!.circuitState).toBe('closed');
    expect(registry.isProviderAvailable('stripe')).toBe(true);
  });

  it('stays closed under a run of failures below the threshold', () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    expect(registry.getManagementView('stripe')!.circuitState).toBe('closed');
    expect(registry.isProviderAvailable('stripe')).toBe(true);
  });

  it('opens after the failure threshold is reached, excluding the provider from routing', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    expect(registry.getManagementView('stripe')!.circuitState).toBe('open');
    expect(registry.isProviderAvailable('stripe')).toBe(false);

    // Capability-based routing must also exclude an open-circuit provider.
    const matches = registry.findByCategoryAndCapabilities('payment', ['card'], 'USD');
    expect(matches.some((m) => m.id === 'stripe')).toBe(false);
  });

  it('a single success resets the consecutive-failure counter while closed', () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    registry.recordTraffic('stripe', true, 100);
    expect(registry.getManagementView('stripe')!.consecutiveFailures).toBe(0);

    // Another run of near-threshold failures still shouldn't trip it,
    // proving the counter actually reset rather than merely capping.
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    expect(registry.getManagementView('stripe')!.circuitState).toBe('closed');
  });

  it('transitions to half-open and allows one probe after the cooldown elapses', () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(start);

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    expect(registry.isProviderAvailable('stripe')).toBe(false);

    // Still within the cooldown window — stays open.
    vi.setSystemTime(new Date(start.getTime() + COOLDOWN_MS - 1));
    expect(registry.isProviderAvailable('stripe')).toBe(false);

    // Cooldown elapsed — the next availability check allows a probe through.
    vi.setSystemTime(new Date(start.getTime() + COOLDOWN_MS + 1));
    expect(registry.isProviderAvailable('stripe')).toBe(true);
    expect(registry.getManagementView('stripe')!.circuitState).toBe('half_open');
  });

  it('a successful half-open probe closes the circuit', () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(start);

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    vi.setSystemTime(new Date(start.getTime() + COOLDOWN_MS + 1));
    expect(registry.isProviderAvailable('stripe')).toBe(true); // enters half-open

    registry.recordTraffic('stripe', true, 100);
    expect(registry.getManagementView('stripe')!.circuitState).toBe('closed');
    expect(registry.getManagementView('stripe')!.consecutiveFailures).toBe(0);
  });

  it('a failed half-open probe re-opens the circuit and restarts the cooldown', () => {
    vi.useFakeTimers();
    const start = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(start);

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    vi.setSystemTime(new Date(start.getTime() + COOLDOWN_MS + 1));
    expect(registry.isProviderAvailable('stripe')).toBe(true); // half-open probe begins

    registry.recordTraffic('stripe', false, 100); // probe fails
    expect(registry.getManagementView('stripe')!.circuitState).toBe('open');

    // Cooldown restarted from the probe failure, not the original open time.
    expect(registry.isProviderAvailable('stripe')).toBe(false);
  });

  it('manually setting a provider online resets the circuit breaker', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      registry.recordTraffic('stripe', false, 100);
    }
    expect(registry.getManagementView('stripe')!.circuitState).toBe('open');

    registry.updateProviderConfig('stripe', { status: 'online' });
    expect(registry.getManagementView('stripe')!.circuitState).toBe('closed');
    expect(registry.getManagementView('stripe')!.consecutiveFailures).toBe(0);
    expect(registry.isProviderAvailable('stripe')).toBe(true);
  });
});
