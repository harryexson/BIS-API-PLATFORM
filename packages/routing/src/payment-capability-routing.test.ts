/**
 * Phase 11-12 — gap register A8 (payments half, deferred from Phase 10).
 *
 * Every payment selection path — explicit providerOverride, admin routing
 * rule target, scored pick, failover cascade — now only ever selects a
 * provider that supports the payment's capability, currency AND country
 * (ProviderRegistry.findByCategoryAndCapabilities). The hardcoded
 * ['stripe','nmi','airwallex'] "global fallback pool" is gone: with no
 * capable provider the payment fails closed (PaymentRouteUnavailableError)
 * and nothing is sent to any provider.
 *
 * Design decision under test: an explicit providerOverride does NOT bypass
 * the capability checks; an online-but-incapable override is rejected with
 * PaymentOverrideIncapableError (not silently swapped for another provider).
 * An offline override keeps its earlier behaviour (fall back to the capable
 * pool) — see routing.test.ts 'falls back when override provider is offline'.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RoutingEngine, PaymentOverrideIncapableError, PaymentRouteUnavailableError } from './index';
import { ProviderRegistry } from '@company/providers';
import type { PaymentRoutingRequest } from '@company/schemas';

describe('Phase 11-12 — payment override / rule-target / fallback pool are capability-checked (A8)', () => {
  const registry = ProviderRegistry.getInstance();
  const engine = new RoutingEngine();
  const restore: Array<() => void> = [];

  afterEach(() => {
    while (restore.length) restore.pop()!();
    vi.restoreAllMocks();
  });

  /** Spies on processRequest of EVERY payment adapter (call-through). */
  function spyAll() {
    const spies = registry
      .getAllConfigs()
      .filter((p) => p.category === 'payment')
      .map((p) => ({ id: p.id, spy: vi.spyOn(registry.getProvider(p.id)!, 'processRequest') }));
    return () => spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.id);
  }

  const pay = (r: Partial<PaymentRoutingRequest>) =>
    engine.routePayment('app_a8', { amount: 5000, paymentTransactionId: randomUUID(), ...r } as PaymentRoutingRequest);

  function setOffline(ids: string[]) {
    for (const id of ids) {
      registry.updateProviderConfig(id, { status: 'offline' });
      restore.push(() => registry.updateProviderConfig(id, { status: 'online' }));
    }
  }

  describe('explicit providerOverride', () => {
    it('an override onto a provider that cannot do the CAPABILITY (Stripe for MWK mobile money) is rejected; no provider is called', async () => {
      const called = spyAll();
      const err = await pay({ currency: 'MWK', paymentMethod: 'mobile_money', providerOverride: 'stripe', phoneNumber: '265991234567' }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PaymentOverrideIncapableError);
      expect((err as PaymentOverrideIncapableError).code).toBe('provider_override_incapable');
      expect((err as Error).message).toContain("does not support payment method 'mobile_money'");
      expect(called()).toEqual([]);
    });

    it('an override onto a provider that cannot do the CURRENCY (Stripe for NGN card) is rejected', async () => {
      const called = spyAll();
      const err = await pay({ currency: 'NGN', paymentMethod: 'card', providerOverride: 'stripe' }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentOverrideIncapableError);
      expect((err as Error).message).toContain('does not support currency NGN');
      expect(called()).toEqual([]);
    });

    it('an override onto a provider not enabled for the COUNTRY (NMI — US/CA only — for a GB card) is rejected', async () => {
      const called = spyAll();
      const err = await pay({ currency: 'USD', paymentMethod: 'card', country: 'GB', providerOverride: 'nmi' }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentOverrideIncapableError);
      expect((err as Error).message).toContain('is not enabled for country GB');
      expect(called()).toEqual([]);
    });

    it('a capable override is still honoured exactly (NMI for a US card)', async () => {
      const called = spyAll();
      const event = await pay({ currency: 'USD', paymentMethod: 'card', country: 'US', providerOverride: 'nmi' });
      expect(event.providerId).toBe('nmi');
      expect(called()).toEqual(['nmi']);
    });
  });

  describe('admin routing-rule target', () => {
    it('a rule whose target cannot take this payment is NOT applied; routing continues within the capable pool only', async () => {
      const rule = registry.addRoutingRule('stripe', { match: 'currency == MWK', target: 'stripe', enabled: true })!;
      restore.push(() => registry.deleteRoutingRule('stripe', rule.id));
      const called = spyAll();

      const event = await pay({ currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567' });

      expect(['pawapay', 'paychangu']).toContain(event.providerId);
      expect(String(event.decisionReason)).toContain("target 'stripe' cannot process MWK/mobile_money");
      expect(String(event.decisionReason)).toContain('rule not applied');
      expect(called()).not.toContain('stripe');
    });

    it('a rule whose target IS capable is still applied', async () => {
      const rule = registry.addRoutingRule('adyen', { match: 'currency == EUR', target: 'adyen', enabled: true })!;
      restore.push(() => registry.deleteRoutingRule('adyen', rule.id));
      const event = await pay({ currency: 'EUR', paymentMethod: 'card' });
      expect(event.providerId).toBe('adyen');
      expect(String(event.decisionReason)).toContain('Routing rule matched');
    });
  });

  describe('no capable provider: fail closed, never the old [stripe, nmi, airwallex] pool', () => {
    it('MWK mobile money with every MWK mobile-money provider offline is a specific failure — it is NOT sent to Stripe/NMI/Airwallex as a card charge', async () => {
      setOffline(['pawapay', 'paychangu']);
      const called = spyAll();
      const err = await pay({ currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567' }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentRouteUnavailableError);
      expect((err as PaymentRouteUnavailableError).code).toBe('payment_route_unavailable');
      expect((err as Error).message).toContain('no online, production-eligible payment provider supports MWK/mobile_money');
      expect((err as Error).message).toContain('NOT sent to any provider');
      expect(called()).toEqual([]);
    });

    it('a currency no provider supports (XOF card) fails closed with no provider call', async () => {
      const called = spyAll();
      await expect(pay({ currency: 'XOF', paymentMethod: 'card' })).rejects.toBeInstanceOf(PaymentRouteUnavailableError);
      expect(called()).toEqual([]);
    });

    it('a country no provider is enabled for fails closed (no country filter bypass)', async () => {
      const called = spyAll();
      // MWK mobile money is MW-only; a request tagged ZA has no capable provider.
      await expect(pay({ currency: 'MWK', paymentMethod: 'mobile_money', country: 'ZA' })).rejects.toThrow(/MWK\/mobile_money\/ZA/);
      expect(called()).toEqual([]);
    });

    it('an offline override + no capable provider is still a specific failure (not a silent route elsewhere)', async () => {
      setOffline(['pawapay', 'paychangu']);
      const called = spyAll();
      await expect(
        pay({ currency: 'MWK', paymentMethod: 'mobile_money', providerOverride: 'pawapay', phoneNumber: '265991234567' }),
      ).rejects.toBeInstanceOf(PaymentRouteUnavailableError);
      expect(called()).toEqual([]);
    });
  });

  it('the decline cascade itself stays inside the capable pool (an MWK decline never cascades to a card provider)', async () => {
    const decline = (id: string) => ({
      id: `${id}_declined`, timestamp: new Date().toISOString(), appId: 'app_a8', category: 'payment' as const, providerId: id,
      status: 'failed' as const, amount: 5000, currency: 'MWK', latency: 1, cost: 0, decisionReason: 'stub', payload: {}, response: null, error: 'declined',
    });
    const pawapay = vi.spyOn(registry.getProvider('pawapay')!, 'processRequest').mockResolvedValue(decline('pawapay'));
    const paychangu = vi.spyOn(registry.getProvider('paychangu')!, 'processRequest').mockResolvedValue(decline('paychangu'));
    const others = registry
      .getAllConfigs()
      .filter((p) => p.category === 'payment' && !['pawapay', 'paychangu'].includes(p.id))
      .map((p) => vi.spyOn(registry.getProvider(p.id)!, 'processRequest'));
    const event = await pay({ currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567' });
    expect(event.status).toBe('failed');
    expect(pawapay).toHaveBeenCalledTimes(1);
    expect(paychangu).toHaveBeenCalledTimes(1);
    for (const spy of others) expect(spy).not.toHaveBeenCalled();
  });
});
