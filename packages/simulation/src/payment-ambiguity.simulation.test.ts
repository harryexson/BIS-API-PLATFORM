/**
 * Phase 11-12 (gap register A10/E4, A8) — end-to-end over real HTTP through
 * the gateway: the real gateway → RoutingEngine → real Stripe adapter, with
 * only `fetch` (the provider's network) stubbed and the database replaced by
 * the in-memory double.
 *
 *  - an ambiguous Stripe outcome (5xx) answers 202 'unknown', stores the
 *    transaction as 'unknown' with NO fabricated provider id, and never
 *    reaches a second provider;
 *  - a genuine Stripe decline still fails over (200 from the next provider);
 *  - an override that cannot do the payment is a specific 422, and a payment
 *    no provider can take is a specific 503 — neither reaches any provider.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, TENANT_ID } from './db';

vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

let runtime: SimRuntime;
const HEADERS = {
  'content-type': 'application/json',
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': TENANT_ID,
};

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

afterEach(() => {
  runtime.registry.getProvider('stripe')!.setSecrets({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stubs only Stripe's API host; the gateway's own in-process HTTP goes through untouched. */
function stubStripe(respond: () => Response) {
  const realFetch = globalThis.fetch;
  const stripeCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.startsWith('https://api.stripe.com/')) {
      stripeCalls.push(url);
      return respond();
    }
    return realFetch(input as any, init);
  }));
  return stripeCalls;
}

function spyOtherPaymentProviders() {
  return runtime.registry
    .getAllConfigs()
    .filter((p) => p.category === 'payment' && p.id !== 'stripe')
    .map((p) => vi.spyOn(runtime.registry.getProvider(p.id)!, 'processRequest'));
}

async function pay(body: Record<string, unknown>) {
  const res = await runtime.post('/v1/api/gateway/payment', { amount: 75, currency: 'USD', paymentMethod: 'card', phoneNumber: '+15550001111', ...body }, HEADERS);
  return { status: res.status, body: await res.json() };
}

describe('Phase 11-12 — gateway end-to-end: ambiguous vs definite payment outcomes', () => {
  it('a Stripe 503 → 202 unknown, row stored unknown with NULL provider id, no second provider called', async () => {
    runtime.registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_sim' });
    const stripeCalls = stubStripe(() => json({ error: { type: 'api_error', message: 'Service unavailable' } }, 503));
    const others = spyOtherPaymentProviders();

    const res = await pay({ providerOverride: 'stripe', paymentToken: 'pm_card_visa' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('unknown');
    expect(res.body.providerId).toBe('stripe');
    expect(stripeCalls.length).toBeGreaterThanOrEqual(1);
    for (const spy of others) expect(spy).not.toHaveBeenCalled();
    const row = dbState.transactions.find((t) => t.id === res.body.paymentTransactionId)!;
    expect(row.status).toBe('unknown');
    expect(row.providerTransactionId).toBeNull();
  }, 15_000);

  it('a genuine Stripe card decline (402 card_error) still fails over to another provider', async () => {
    runtime.registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_sim' });
    const stripeCalls = stubStripe(() =>
      json({ error: { type: 'card_error', code: 'card_declined', decline_code: 'do_not_honor', message: 'Your card was declined.' } }, 402),
    );

    const res = await pay({ providerOverride: 'stripe', paymentToken: 'pm_card_visa' });

    expect(stripeCalls).toHaveLength(1);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.providerId).not.toBe('stripe');
    expect(String(res.body.decisionReason)).toContain('do_not_honor');
  });

  it('an incapable override (Stripe for MWK mobile money) → 422 provider_override_incapable; nothing sent; row failed', async () => {
    const stripeCalls = stubStripe(() => json({}));
    const all = runtime.registry
      .getAllConfigs()
      .filter((p) => p.category === 'payment')
      .map((p) => vi.spyOn(runtime.registry.getProvider(p.id)!, 'processRequest'));

    const res = await pay({ providerOverride: 'stripe', currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '+265991234567' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('provider_override_incapable');
    expect(String(res.body.detail)).toContain('mobile_money');
    expect(stripeCalls).toEqual([]);
    for (const spy of all) expect(spy).not.toHaveBeenCalled();
    expect(dbState.transactions.find((t) => t.id === res.body.paymentTransactionId)!.status).toBe('failed');
  });

  it('no capable provider (XOF card) → 503 payment_route_unavailable; nothing sent', async () => {
    const all = runtime.registry
      .getAllConfigs()
      .filter((p) => p.category === 'payment')
      .map((p) => vi.spyOn(runtime.registry.getProvider(p.id)!, 'processRequest'));

    const res = await pay({ currency: 'XOF' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('payment_route_unavailable');
    expect(String(res.body.detail)).toContain('XOF/card');
    for (const spy of all) expect(spy).not.toHaveBeenCalled();
  });
});
