import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, installDatabaseMock, seedReachChurch } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, real RoutingEngine, real ProviderRegistry — is the
// REAL code (services/api-gateway/src/app.ts, packages/routing/src/index.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Dynamic routing — admin rules, success-rate/cost scoring, cascading waterfall\n`);

const ADMIN_TOKEN = 'sim-dynamic-routing-admin-token';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const HEADERS = {
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': 'ten_reach_church',
};

let runtime: SimRuntime;

beforeAll(async () => {
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

async function addRoutingRule(providerId: string, rule: { match: string; target: string; description?: string; enabled?: boolean }) {
  const res = await runtime.post(`/api/dashboard/providers/${providerId}/routing`, rule, ADMIN);
  expect(res.status).toBe(201);
  return res.json();
}

async function deleteRoutingRule(providerId: string, ruleId: string) {
  const res = await runtime.request('DELETE', `/api/dashboard/providers/${providerId}/routing/${ruleId}`, { headers: ADMIN });
  expect(res.status).toBe(200);
}

async function payWithoutOverride(overrides: Record<string, unknown> = {}) {
  const res = await runtime.post('/v1/api/gateway/payment', {
    amount: 100,
    currency: 'USD',
    paymentMethod: 'card',
    phoneNumber: '+15550001111',
    ...overrides,
  }, HEADERS);
  return { res, body: await res.json() };
}

beforeEach(() => {
  clearDb();
  seedReachChurch();
});

describe('admin-configured routing rules — actually consulted by RoutingEngine', () => {
  it('a matching enabled rule overrides success-rate/cost-based selection', async () => {
    const rule = await addRoutingRule('nmi', {
      match: 'amount > 40',
      target: 'nmi',
      description: 'route larger card donations to NMI',
    });
    try {
      const { res, body } = await payWithoutOverride({ amount: 100 });
      expect(res.status).toBe(200);
      expect(body.providerId).toBe('nmi');
      expect(String(body.decisionReason)).toContain('Routing rule matched');
      expect(String(body.decisionReason)).toContain('route larger card donations to NMI');
    } finally {
      await deleteRoutingRule('nmi', rule.id);
    }
  });

  it('a disabled rule is never consulted', async () => {
    const rule = await addRoutingRule('nmi', { match: 'amount > 40', target: 'nmi', enabled: false });
    try {
      const { res, body } = await payWithoutOverride({ amount: 100 });
      expect(res.status).toBe(200);
      expect(String(body.decisionReason)).not.toContain('Routing rule matched');
    } finally {
      await deleteRoutingRule('nmi', rule.id);
    }
  });

  it('a rule that does not match this request is never consulted', async () => {
    const rule = await addRoutingRule('nmi', { match: 'currency == MWK', target: 'nmi' });
    try {
      const { res, body } = await payWithoutOverride({ amount: 100, currency: 'USD' });
      expect(res.status).toBe(200);
      expect(String(body.decisionReason)).not.toContain('Routing rule matched');
    } finally {
      await deleteRoutingRule('nmi', rule.id);
    }
  });

  it('a rule whose target is offline falls through to normal scored selection instead of failing the request', async () => {
    await runtime.registry.updateManagement('paychangu', { status: 'offline' });
    const rule = await addRoutingRule('paychangu', { match: 'amount > 40', target: 'paychangu' });
    try {
      const { res, body } = await payWithoutOverride({ amount: 100 });
      expect(res.status).toBe(200);
      expect(body.providerId).not.toBe('paychangu');
      expect(String(body.decisionReason)).toContain('target');
      expect(String(body.decisionReason)).toContain('offline/invalid');
    } finally {
      await deleteRoutingRule('paychangu', rule.id);
      await runtime.registry.updateManagement('paychangu', { status: 'online' });
    }
  });
});

describe('cascading waterfall retries', () => {
  it('cascades through more than one fallback, in score order, until a healthy provider succeeds', async () => {
    // Shrink the USD/card candidate pool to exactly 3 (MAX_ROUTING_ATTEMPTS
    // defaults to 3) so this is fully deterministic without needing to
    // touch that module-load-time constant: stripe (forced attempt 1 via
    // override, broken), flutterwave (real weight 50 + cheaper fee beats
    // nmi's weight 30 + pricier fee, so it deterministically outscores nmi
    // and lands as attempt 2, broken), nmi (the sole survivor, attempt 3).
    const sidelined = ['paychangu', 'airwallex', 'example-pay'];
    for (const id of sidelined) await runtime.registry.updateManagement(id, { status: 'offline' });

    const broken = ['stripe', 'flutterwave'];
    const originals = new Map<string, (...a: unknown[]) => Promise<unknown>>();
    for (const id of broken) {
      const provider = runtime.registry.getProvider(id) as unknown as { processRequest: (...a: unknown[]) => Promise<unknown> };
      originals.set(id, provider.processRequest.bind(provider));
      provider.processRequest = async () => { throw new Error(`simulated ${id} outage`); };
    }

    try {
      // Deterministic starting point via providerOverride — an
      // override-selected provider still gets the full cascading fallback
      // order on failure (see routePayment), so this exercises the real
      // cascade without depending on which provider a weighted-random
      // initial pick happens to land on.
      const { res, body } = await payWithoutOverride({ amount: 100, providerOverride: 'stripe' });
      expect(res.status).toBe(200);
      expect(body.providerId).toBe('nmi');
      const cascadeHops = (String(body.decisionReason).match(/Dynamic Failover \(cascading, attempt/g) ?? []).length;
      expect(cascadeHops).toBe(2);
      expect(String(body.decisionReason)).toContain('simulated stripe outage');
      expect(String(body.decisionReason)).toContain('simulated flutterwave outage');
    } finally {
      for (const [id, fn] of originals) {
        (runtime.registry.getProvider(id) as unknown as { processRequest: unknown }).processRequest = fn;
      }
      for (const id of sidelined) await runtime.registry.updateManagement(id, { status: 'online' });
    }
  });

  // The payment-timeout-stops-the-cascade-with-'unknown' safety rule (a
  // timeout is ambiguous — the provider may have already processed the
  // charge, so it must never be retried through another provider) is
  // already covered precisely by packages/routing/src/routing.test.ts's
  // "deliberate: provider timeout" suite, which this pass's cascade
  // rewrite kept passing unchanged — not duplicated here.
});
