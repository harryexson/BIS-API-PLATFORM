import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, TENANT_ID, APP_SLUG } from './db';

// Phase 3 — gap register C1/E1 (payment fields dropped by the public
// routes), E7/C11 (deterministic provider idempotency identity) and E2
// (production kill-switch), proven through the REAL gateway routes
// (services/api-gateway/src/app.ts), the REAL RoutingEngine and the REAL
// Stripe adapter. For the real-HTTP proof the Stripe adapter is pointed at
// a local HTTP server that behaves like Stripe's PaymentIntents endpoint
// (form-encoded body, Idempotency-Key replay semantics).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, sleep, type SimRuntime } from './harness';
import { RoutingEngine } from '@company/routing';

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': TENANT_ID,
};

let runtime: SimRuntime;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const restores: Array<() => void> = [];

// ---------------------------------------------------------------------------
// A minimal Stripe stand-in: records every request and honours
// Idempotency-Key the way Stripe documents (same key → the SAME saved
// response, no second PaymentIntent).
// ---------------------------------------------------------------------------
interface StripeCall {
  method: string;
  path: string;
  idempotencyKey: string | undefined;
  authorization: string | undefined;
  form: Record<string, string>;
}
const stripeCalls: StripeCall[] = [];
const stripeByKey = new Map<string, unknown>();
let intentsCreated = 0;
let stripeServer: http.Server;
let stripeBaseUrl: string;

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();

  stripeServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const key = req.headers['idempotency-key'] as string | undefined;
      stripeCalls.push({
        method: req.method || '',
        path: req.url || '',
        idempotencyKey: key,
        authorization: req.headers.authorization,
        form: Object.fromEntries(new URLSearchParams(raw)),
      });
      let body = key ? stripeByKey.get(key) : undefined;
      if (!body) {
        intentsCreated++;
        body = {
          id: `pi_mock_${intentsCreated}`,
          object: 'payment_intent',
          status: 'succeeded',
          latest_charge: { id: `ch_mock_${intentsCreated}`, outcome: { risk_level: 'normal', type: 'authorized' } },
        };
        if (key) stripeByKey.set(key, body);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => stripeServer.listen(0, '127.0.0.1', () => resolve()));
  stripeBaseUrl = `http://127.0.0.1:${(stripeServer.address() as AddressInfo).port}/v1`;
}, 30_000);

afterAll(async () => {
  await runtime.close();
  await new Promise<void>((resolve) => stripeServer.close(() => resolve()));
}, 15_000);

beforeEach(() => {
  stripeCalls.length = 0;
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  delete process.env.STRIPE_SECRET_KEY;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

type Adapter = { processRequest: (appId: string, payload: any, reason: string) => Promise<any>; [k: string]: any };

/** Capture the payload every payment adapter receives (optionally delaying it). */
function instrumentPaymentAdapters(opts: { delayMs?: number } = {}) {
  const calls: Array<{ providerId: string; payload: any }> = [];
  for (const cfg of runtime.registry.getAllConfigs().filter((c) => c.category === 'payment')) {
    const adapter = runtime.registry.getProvider(cfg.id) as unknown as Adapter;
    const original = adapter.processRequest;
    adapter.processRequest = async function (appId: string, payload: any, reason: string) {
      calls.push({ providerId: cfg.id, payload });
      if (opts.delayMs) await sleep(opts.delayMs);
      return original.call(adapter, appId, payload, reason);
    };
    restores.push(() => {
      adapter.processRequest = original;
    });
  }
  return calls;
}

/** Point the real Stripe adapter at the local Stripe stand-in, with a configured secret key. */
function useMockStripe() {
  const stripe = runtime.registry.getProvider('stripe') as unknown as Adapter;
  const originalBase = stripe.baseUrl;
  stripe.baseUrl = stripeBaseUrl;
  process.env.STRIPE_SECRET_KEY = 'sk_test_phase3_mock';
  restores.push(() => {
    stripe.baseUrl = originalBase;
  });
}

async function pay(body: Record<string, unknown>, key?: string, auth: Record<string, string> = AUTH) {
  const res = await runtime.post(
    '/v1/api/gateway/payment',
    { amount: 40, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', ...body },
    key ? { ...auth, 'idempotency-key': key } : auth,
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const txById = (id: string) => dbState.transactions.find((t) => t.id === id);

describe('Phase 3 — public payment route forwards every payment field (C1/E1)', () => {
  it('paymentToken, country, metadata, idempotencyKey and the pre-allocated paymentTransactionId reach the adapter payload', async () => {
    const calls = instrumentPaymentAdapters();
    const res = await pay(
      { paymentToken: 'pm_card_visa', country: 'us', metadata: { donorId: 'd-17', campaign: 'spring' } },
      'p3-forward-001',
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const payload = calls[0].payload;
    expect(payload.paymentToken).toBe('pm_card_visa');
    expect(payload.country).toBe('US'); // validated + normalised
    expect(payload.metadata).toEqual({ donorId: 'd-17', campaign: 'spring' });
    expect(payload.idempotencyKey).toBe('p3-forward-001');

    // The transaction row existed BEFORE the provider call and is the one updated afterwards.
    expect(typeof payload.paymentTransactionId).toBe('string');
    expect(res.body.paymentTransactionId).toBe(payload.paymentTransactionId);
    const row = txById(payload.paymentTransactionId)!;
    expect(row).toBeDefined();
    expect(row.idempotencyKey).toBe('p3-forward-001');
    expect(row.status).toBe('success');
    expect(row.providerId).toBe('stripe');
    expect(row.providerTransactionId).toBe(res.body.id);
    expect(dbState.transactions.filter((t) => t.idempotencyKey === 'p3-forward-001')).toHaveLength(1);
  });

  it('rejects malformed paymentToken / country / metadata with 400 before anything is charged or recorded', async () => {
    const calls = instrumentPaymentAdapters();
    const before = dbState.transactions.length;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ paymentToken: '' }, 'paymentToken'],
      [{ paymentToken: 12345 }, 'paymentToken'],
      [{ country: 'USA' }, 'country'],
      [{ country: 'U1' }, 'country'],
      [{ metadata: ['not', 'an', 'object'] }, 'metadata'],
      [{ metadata: 'string' }, 'metadata'],
      [{ amount: -5 }, 'amount'],
      [{ amount: 'abc' }, 'amount'],
    ];
    for (const [body, field] of cases) {
      const res = await pay(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
      expect(res.body.error.field).toBe(field);
    }
    expect(calls).toHaveLength(0);
    expect(dbState.transactions.length).toBe(before);
  });

  it('with a configured Stripe key, the token goes to Stripe over real HTTP with bis_<payment_transaction_id>_<key> — no simulated success', async () => {
    useMockStripe();
    const res = await pay({ paymentToken: 'pm_card_visa', metadata: { donorId: 'd-1' } }, 'p3-real-http-001');

    expect(res.status).toBe(200);
    expect(stripeCalls).toHaveLength(1);
    const call = stripeCalls[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v1/payment_intents');
    expect(call.authorization).toBe('Bearer sk_test_phase3_mock');
    expect(call.form.payment_method).toBe('pm_card_visa');
    expect(call.form.amount).toBe('4000');
    expect(call.form.confirm).toBe('true');

    const ptx = res.body.paymentTransactionId as string;
    expect(call.idempotencyKey).toBe(`bis_${ptx}_p3-real-http-001`);
    expect(call.form['metadata[bisPaymentTransactionId]']).toBe(ptx);

    // The response is Stripe's real PaymentIntent, not a fabricated pi_<random>.
    expect(res.body.id).toMatch(/^pi_mock_\d+$/);
    expect(res.body.response.id).toBe(res.body.id);
    expect(txById(ptx)!.providerTransactionId).toBe(res.body.id);
    expect(txById(ptx)!.status).toBe('success');
  });

  it('without a paymentToken (test env) Stripe is NOT called — the simulated path is used, and that is visible', async () => {
    useMockStripe();
    const res = await pay({}, 'p3-no-token-001');
    expect(res.status).toBe(200);
    expect(stripeCalls).toHaveLength(0);
    expect(res.body.id).not.toMatch(/^pi_mock_/);
  });
});

describe('Phase 3 — deterministic provider idempotency identity end-to-end (E7/C11)', () => {
  it('two different payments (same amount, same minute, no client key) get two different Stripe Idempotency-Keys', async () => {
    useMockStripe();
    const a = await pay({ paymentToken: 'pm_card_visa' });
    const b = await pay({ paymentToken: 'pm_card_visa' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(stripeCalls).toHaveLength(2);
    expect(stripeCalls[0].idempotencyKey).toBe(`bis_${a.body.paymentTransactionId}_default`);
    expect(stripeCalls[1].idempotencyKey).toBe(`bis_${b.body.paymentTransactionId}_default`);
    expect(stripeCalls[0].idempotencyKey).not.toBe(stripeCalls[1].idempotencyKey);
    // ...so they are two real charges (the old minute-bucketed fallback
    // `pi_<app>_<amount>_<currency>_<minute>` collapsed these into one).
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('an attempt whose response was lost after Stripe charged, retried under the same client key, re-sends the SAME identity — Stripe dedupes, one charge', async () => {
    useMockStripe();
    const key = 'p3-lost-response-001';
    const original = RoutingEngine.prototype.routePayment;
    let loseNext = true;
    RoutingEngine.prototype.routePayment = async function (this: RoutingEngine, ...args: Parameters<RoutingEngine['routePayment']>) {
      const event = await original.apply(this, args); // Stripe really processes it...
      if (loseNext) {
        loseNext = false;
        throw new Error('socket hang up (simulated: response lost after provider processed)'); // ...but we never see the result
      }
      return event;
    };
    restores.push(() => {
      RoutingEngine.prototype.routePayment = original;
    });

    const intentsBefore = intentsCreated;
    const first = await pay({ paymentToken: 'pm_card_visa' }, key);
    expect(first.status).toBe(503);
    const ptx = first.body.paymentTransactionId as string;
    expect(txById(ptx)!.status).toBe('failed');
    expect(txById(ptx)!.providerTransactionId).toBeNull();

    const retry = await pay({ paymentToken: 'pm_card_visa' }, key);
    expect(retry.status).toBe(200);
    expect(retry.body.paymentTransactionId).toBe(ptx); // same platform transaction row reused

    expect(stripeCalls).toHaveLength(2);
    expect(stripeCalls[0].idempotencyKey).toBe(`bis_${ptx}_${key}`);
    expect(stripeCalls[1].idempotencyKey).toBe(stripeCalls[0].idempotencyKey);
    expect(intentsCreated - intentsBefore).toBe(1); // Stripe created exactly ONE PaymentIntent
    expect(txById(ptx)!.providerTransactionId).toBe(retry.body.id);
    expect(dbState.transactions.filter((t) => t.idempotencyKey === key)).toHaveLength(1);
  });

  it('the transaction row is durable BEFORE the provider is called; a DB outage refuses the payment without calling any provider', async () => {
    const calls = instrumentPaymentAdapters();
    dbState.failTransactionWrites = true;
    try {
      const res = await pay({ paymentToken: 'pm_card_visa' }, 'p3-db-down-001');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('payment_record_unavailable');
      expect(calls).toHaveLength(0);
    } finally {
      dbState.failTransactionWrites = false;
    }
    // The key is reusable afterwards (claim was failed, nothing charged).
    const ok = await pay({ paymentToken: 'pm_card_visa' }, 'p3-db-down-001');
    expect(ok.status).toBe(200);
  });
});

describe('Phase 3 — hosted checkout /pay forwards fields and allocates first', () => {
  async function createSession(metadata?: Record<string, unknown>) {
    const res = await runtime.post('/v1/api/gateway/checkout-sessions', { amount: 25, currency: 'USD', metadata }, AUTH);
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; id: string };
  }

  it('forwards paymentToken/country/metadata (merchant session metadata wins over shopper metadata) with a paymentTransactionId', async () => {
    const calls = instrumentPaymentAdapters();
    const session = await createSession({ campaign: 'merchant-set' });
    const res = await runtime.post(`/v1/checkout/sessions/${session.token}/pay`, {
      paymentMethod: 'card',
      paymentToken: 'tok_shopper_1',
      country: 'gb',
      metadata: { campaign: 'shopper-tried-to-override', note: 'hi' },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const payload = calls[0].payload;
    expect(payload.paymentToken).toBe('tok_shopper_1');
    expect(payload.country).toBe('GB');
    expect(payload.metadata).toEqual({ campaign: 'merchant-set', note: 'hi' });
    expect(payload.paymentTransactionId).toBe(body.paymentTransactionId);
    expect(payload.idempotencyKey).toBe(`checkout_session_${session.id}`);
    expect(payload.idempotencyKey).not.toContain(session.token); // the bearer token never leaves the platform
    expect(txById(body.paymentTransactionId)!.providerTransactionId).toBe(body.id);
  });

  it('two concurrent /pay calls on one session reach a provider exactly once (the second loses the allocation, 409, before any charge)', async () => {
    const calls = instrumentPaymentAdapters({ delayMs: 250 });
    const session = await createSession();
    const [r1, r2] = await Promise.all([
      runtime.post(`/v1/checkout/sessions/${session.token}/pay`, { paymentMethod: 'card' }),
      runtime.post(`/v1/checkout/sessions/${session.token}/pay`, { paymentMethod: 'card' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
    expect(dbState.transactions.filter((t) => t.idempotencyKey === `checkout_session_${session.id}`)).toHaveLength(1);
  });
});

describe('Phase 3 — production kill-switch end-to-end (E2)', () => {
  it('NODE_ENV=production with no provider credentials: no fabricated success — 503, failed row, no provider id', async () => {
    // Phase 15 (gap register C9): a production deployment only accepts a
    // LIVE-tier API key (the seeded reach-church key is development/test
    // tier and is now refused with 401 there). This test is about what
    // happens AFTER authentication, so it authenticates with a live key.
    const liveKey = 'bap_live_reachchurch_p3_killswitch';
    dbState.apiKeys.push({
      id: 'key_reach_church_live_p3',
      keyHash: createHash('sha256').update(liveKey).digest('hex'),
      applicationId: `app_${APP_SLUG}`,
      environment: 'live',
      revokedAt: null,
      expiresAt: null,
    });
    process.env.NODE_ENV = 'production';
    const res = await pay({ paymentToken: 'pm_card_visa' }, 'p3-prod-unconfigured-001', { ...AUTH, authorization: `Bearer ${liveKey}` });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Payment routing failed');
    const row = txById(res.body.paymentTransactionId)!;
    expect(row.status).toBe('failed');
    expect(row.providerTransactionId).toBeNull();
    expect(JSON.stringify(row.metadata)).toContain('not configured for real processing');
  });

  it('the same request in NODE_ENV=test still simulates (dev/test behaviour unchanged)', async () => {
    process.env.NODE_ENV = 'test';
    const res = await pay({ paymentToken: 'pm_card_visa' }, 'p3-test-unconfigured-001');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });
});
