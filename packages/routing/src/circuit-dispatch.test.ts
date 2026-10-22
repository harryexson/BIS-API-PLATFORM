/**
 * Phase 15 — gap register A14a/A14d at the ROUTER level (RoutingEngine's
 * private dispatch(), the one place a provider is actually called).
 *
 *  - A14d: every real provider attempt in a failover cascade is recorded
 *    against that provider's circuit breaker — not just the final event the
 *    gateway's observe() used to see. A provider that declined/failed
 *    earlier in the cascade gets its failure recorded; the one that
 *    succeeded gets its success recorded. A DEFINITE thrown error (nothing
 *    was sent) is not charged to the provider; an ambiguous one is.
 *  - A14a: the dispatch is claimed (tryAcquireDispatch) immediately before
 *    the provider call. A provider that was eligible when the cascade was
 *    ranked, but whose single HALF_OPEN recovery probe was taken by a
 *    concurrent request in the meantime, is NOT called (a second probe) —
 *    and that refusal is not recorded as a provider failure.
 *
 * The candidate pool is pinned to stripe + nmi (both card/USD) by taking
 * every other payment provider offline; only `Date` is faked, so the
 * provider-timeout setTimeout inside withProviderTimeout stays real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoutingEngine } from './index';
import { ProviderRegistry, ProviderUnavailableError } from '@company/providers';
import type { TransactionEvent } from '@company/schemas';

const COOLDOWN_MS = 30_000;

describe('Phase 15 — router records every cascade attempt and admits exactly one half-open probe (A14a/A14d)', () => {
  const registry = ProviderRegistry.getInstance();
  const engine = new RoutingEngine();
  const paymentIds = () => registry.getAllConfigs().filter((p) => p.category === 'payment').map((p) => p.id);

  const event = (id: string, status: TransactionEvent['status']): TransactionEvent => ({
    id: `${id}_${status}`, timestamp: new Date().toISOString(), appId: 'app_p15_a14', category: 'payment', providerId: id,
    status, amount: 25, currency: 'USD', latency: 3, cost: 0, decisionReason: 'stub', payload: {}, response: null,
    ...(status === 'failed' ? { error: 'card_declined' } : {}),
  });

  const pay = () => engine.routePayment('app_p15_a14', { amount: 25, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe' });
  const view = (id: string) => registry.getManagementView(id)!;

  beforeEach(() => {
    // Online + closed circuits for every payment provider, then pin the pool.
    for (const id of paymentIds()) registry.updateProviderConfig(id, { status: 'online' });
    for (const id of paymentIds()) if (id !== 'stripe' && id !== 'nmi') registry.updateProviderConfig(id, { status: 'offline' });
    expect(registry.findByCategoryAndCapabilities('payment', ['card'], 'USD').map((c) => c.id).sort()).toEqual(['nmi', 'stripe']);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of paymentIds()) registry.updateProviderConfig(id, { status: 'online' });
  });

  it('A14d: a provider that declined EARLIER in the cascade has its failure recorded; the provider that succeeded has its success recorded', async () => {
    const stripe = vi.spyOn(registry.getProvider('stripe')!, 'processRequest').mockResolvedValue(event('stripe', 'failed'));
    const nmi = vi.spyOn(registry.getProvider('nmi')!, 'processRequest').mockResolvedValue(event('nmi', 'success'));
    expect(view('stripe').consecutiveFailures).toBe(0);
    expect(view('nmi').lastSuccessfulRequest).toBeNull();

    const result = await pay();

    expect(result.providerId).toBe('nmi');
    expect(result.status).toBe('success');
    expect(stripe).toHaveBeenCalledTimes(1);
    expect(nmi).toHaveBeenCalledTimes(1);
    // The mid-cascade decline is charged to stripe (the final event names nmi only).
    expect(view('stripe').consecutiveFailures).toBe(1);
    expect(view('stripe').errorRate).toBeGreaterThan(0);
    expect(view('nmi').consecutiveFailures).toBe(0);
    expect(view('nmi').lastSuccessfulRequest).not.toBeNull();
  });

  it('A14d: a definite thrown error (nothing sent) is not charged to the provider; an ambiguous one is', async () => {
    vi.spyOn(registry.getProvider('stripe')!, 'processRequest').mockRejectedValue(new ProviderUnavailableError('stripe is not configured'));
    vi.spyOn(registry.getProvider('nmi')!, 'processRequest').mockResolvedValue(event('nmi', 'success'));
    expect((await pay()).providerId).toBe('nmi');
    expect(view('stripe').consecutiveFailures).toBe(0);

    vi.spyOn(registry.getProvider('stripe')!, 'processRequest').mockRejectedValue(new Error('socket hang up'));
    expect((await pay()).status).toBe('unknown'); // ambiguous: never failed over...
    expect(view('stripe').consecutiveFailures).toBe(1); // ...but charged to stripe's breaker
  });

  it('A14a: a cascade candidate whose half-open probe was taken by a concurrent request is not called — and not charged a failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 5; i++) registry.recordTraffic('nmi', false, 10);
    expect(view('nmi').circuitState).toBe('open');
    vi.setSystemTime(Date.now() + COOLDOWN_MS + 1);
    // Cooldown elapsed: nmi is eligible again as the recovery-probe candidate.
    expect(registry.isProviderAvailable('nmi')).toBe(true);

    let concurrentProbeAdmitted: boolean | undefined;
    const stripe = vi.spyOn(registry.getProvider('stripe')!, 'processRequest').mockImplementation(async () => {
      // While stripe is in flight, another request claims nmi's single probe.
      concurrentProbeAdmitted = registry.tryAcquireDispatch('nmi');
      return event('stripe', 'failed');
    });
    const nmi = vi.spyOn(registry.getProvider('nmi')!, 'processRequest').mockResolvedValue(event('nmi', 'success'));

    await expect(pay()).rejects.toThrow(/circuit breaker recovery probe in flight/);

    expect(stripe).toHaveBeenCalledTimes(1);
    expect(concurrentProbeAdmitted).toBe(true);
    expect(nmi).not.toHaveBeenCalled(); // no second probe
    expect(view('nmi').circuitState).toBe('half_open');
    expect(view('nmi').consecutiveFailures).toBe(5); // the refusal is not a provider failure
  });
});
