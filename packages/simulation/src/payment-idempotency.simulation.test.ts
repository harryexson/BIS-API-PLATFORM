import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, TENANT_ID } from './db';

// Phase 2 — payment idempotency through the REAL gateway routes
// (services/api-gateway/src/app.ts) and the REAL PlatformIdempotencyService
// (packages/shared/src/idempotency.ts). Only the database is replaced, by the
// in-memory model in ./db, whose idempotencyRecordRepository.claim() models
// the single INSERT ... ON CONFLICT DO UPDATE ... WHERE statement and whose
// transactionRepository.create() enforces idx_transactions_idempotency.
// The SQL itself is proven against a real Postgres in
// packages/database/src/idempotency.postgres.integration.test.ts.
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, sleep, type SimRuntime } from './harness';
import { RoutingEngine } from '@company/routing';

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': TENANT_ID,
};

let runtime: SimRuntime;
const restores: Array<() => void> = [];

// Gap register C2/D9: an idempotency failure used to surface as an unhandled
// promise rejection that killed the whole gateway process. Count them.
let unhandledRejections = 0;
const onUnhandled = () => {
  unhandledRejections++;
};

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  process.on('unhandledRejection', onUnhandled);
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await runtime.close();
}, 15_000);

beforeEach(() => {
  unhandledRejections = 0;
  dbState.failIdempotencyStore = false;
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  dbState.failIdempotencyStore = false;
});

/** Wrap Stripe's processRequest to count real provider calls (and optionally delay them). */
function instrumentStripe(opts: { delayMs?: number } = {}) {
  const stripe = runtime.registry.getProvider('stripe') as unknown as {
    processRequest: (appId: string, payload: any, decisionReason: string) => Promise<any>;
  };
  const original = stripe.processRequest;
  const calls: any[] = [];
  stripe.processRequest = async function (this: unknown, appId: string, payload: any, reason: string) {
    calls.push(payload);
    if (opts.delayMs) await sleep(opts.delayMs);
    return original.call(stripe, appId, payload, reason);
  };
  restores.push(() => {
    stripe.processRequest = original;
  });
  return calls;
}

async function pay(key: string | undefined, body: Record<string, unknown> = {}) {
  const res = await runtime.post(
    '/v1/api/gateway/payment',
    { amount: 40, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', phoneNumber: '+15550001111', ...body },
    key ? { ...AUTH, 'idempotency-key': key } : AUTH,
  );
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

const txWithKey = (key: string) => dbState.transactions.filter((t) => t.idempotencyKey === key);
const recordFor = (key: string, operation = 'payment') =>
  dbState.idempotencyRecords.find((r) => r.idempotencyKey === key && r.operation === operation);

async function gatewayStillServing() {
  const res = await runtime.request('GET', '/health');
  expect(res.status).toBe(200);
}

describe('Phase 2 — payment idempotency (gateway, DB-constraint semantics)', () => {
  it('1. concurrent identical requests: exactly one charge + one transaction; every caller gets the SAME result', async () => {
    const calls = instrumentStripe({ delayMs: 250 });
    const key = 'p2:concurrent:001';

    const results = await Promise.all(Array.from({ length: 5 }, () => pay(key)));

    for (const r of results) expect(r.status).toBe(200);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(results[0].body.id).toBeTruthy();
    expect(calls.length).toBe(1); // the provider was charged exactly once
    expect(txWithKey(key)).toHaveLength(1); // exactly one transaction row
    expect(txWithKey(key)[0].providerTransactionId).toBe(results[0].body.id);
    expect(recordFor(key)?.status).toBe('completed');
    expect(dbState.idempotencyRecords.filter((r) => r.idempotencyKey === key)).toHaveLength(1);
    expect(unhandledRejections).toBe(0);
  });

  it('1b. sequential replay of the same key + body returns the cached result without charging again', async () => {
    const calls = instrumentStripe();
    const key = 'p2:sequential:001';
    const first = await pay(key);
    const second = await pay(key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(calls.length).toBe(1);
    expect(txWithKey(key)).toHaveLength(1);
  });

  it('2. same key with a DIFFERENT body is rejected with 409 idempotency_conflict — never charged, never crashes', async () => {
    const calls = instrumentStripe();
    const key = 'p2:mismatch:001';
    const first = await pay(key, { amount: 40 });
    expect(first.status).toBe(200);

    const second = await pay(key, { amount: 4000 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_conflict');
    expect(second.body.error.resource?.id).toBe(first.body.id);

    expect(calls.length).toBe(1);
    expect(txWithKey(key)).toHaveLength(1);
    expect(txWithKey(key)[0].amount).toBe('40');
    expect(recordFor(key)?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unhandledRejections).toBe(0);
    await gatewayStillServing();
  });

  it('2b. a different body is rejected immediately even while the original request is still in flight', async () => {
    const calls = instrumentStripe({ delayMs: 400 });
    const key = 'p2:mismatch-inflight:001';
    const firstP = pay(key, { amount: 40 });
    await sleep(50);
    const started = Date.now();
    const second = await pay(key, { amount: 41 });
    expect(Date.now() - started).toBeLessThan(300); // did not wait for the first one
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_conflict');
    const first = await firstP;
    expect(first.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(txWithKey(key)).toHaveLength(1);
  });

  it('3a. key reuse after the claim EXPIRED (earlier attempt died before charging): re-claimed via the upsert path, charged once, no crash', async () => {
    const key = 'p2:expired-crashed:001';
    // Leftover row from an earlier request that died mid-flight: still
    // 'processing', TTL elapsed, no transaction. The old code's bare INSERT
    // hit 23505 here and crashed the gateway.
    dbState.idempotencyRecords.push({
      id: 'idem_stale_owner',
      appId: 'reach-church',
      tenantId: TENANT_ID,
      operation: 'payment',
      idempotencyKey: key,
      requestHash: 'f'.repeat(64),
      status: 'processing',
      result: null,
      createdAt: new Date(Date.now() - 10 * 60_000),
      expiresAt: new Date(Date.now() - 5 * 60_000),
    });
    const calls = instrumentStripe();

    const res = await pay(key);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(txWithKey(key)).toHaveLength(1);
    const rows = dbState.idempotencyRecords.filter((r) => r.idempotencyKey === key);
    expect(rows).toHaveLength(1); // updated in place, not a second row
    expect(rows[0].id).not.toBe('idem_stale_owner'); // fencing id rotated
    expect(rows[0].status).toBe('completed');
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(unhandledRejections).toBe(0);
    await gatewayStillServing();
  });

  it('3b. key reuse after a COMPLETED claim expired: re-claim succeeds, but the key already produced a transaction, so no second charge (409)', async () => {
    const calls = instrumentStripe();
    const key = 'p2:expired-completed:001';
    const first = await pay(key);
    expect(first.status).toBe(200);
    // Simulate the TTL elapsing.
    recordFor(key)!.expiresAt = new Date(Date.now() - 1000);

    const second = await pay(key);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_conflict');
    expect(second.body.error.resource.id).toBe(first.body.id);
    expect(calls.length).toBe(1); // never charged twice
    expect(txWithKey(key)).toHaveLength(1);
    expect(dbState.idempotencyRecords.filter((r) => r.idempotencyKey === key)).toHaveLength(1);
    expect(unhandledRejections).toBe(0);
    await gatewayStillServing();
  });

  it("4. key reuse after the prior attempt was marked 'failed': re-claim succeeds cleanly and the retry is processed once", async () => {
    const key = 'p2:failed:001';
    const original = RoutingEngine.prototype.routePayment;
    let failNext = true;
    RoutingEngine.prototype.routePayment = async function (this: RoutingEngine, ...args: Parameters<RoutingEngine['routePayment']>) {
      if (failNext) {
        failNext = false;
        throw new Error('simulated routing failure');
      }
      return original.apply(this, args);
    };
    restores.push(() => {
      RoutingEngine.prototype.routePayment = original;
    });

    const first = await pay(key);
    expect(first.status).toBe(503);
    expect(recordFor(key)?.status).toBe('failed');
    // Phase 3: the transaction row is allocated BEFORE routing (it supplies
    // the payment_transaction_id for the provider idempotency identity), so
    // a failed attempt leaves a durable 'failed' row with no provider
    // transaction id — previously asserted as "no row at all".
    expect(txWithKey(key)).toHaveLength(1);
    expect(txWithKey(key)[0].status).toBe('failed');
    expect(txWithKey(key)[0].providerTransactionId).toBeNull();
    const failedAttemptRowId = txWithKey(key)[0].id;
    expect(first.body.paymentTransactionId).toBe(failedAttemptRowId);

    const calls = instrumentStripe();
    const retry = await pay(key);
    expect(retry.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(txWithKey(key)).toHaveLength(1);
    // ...and the retry REUSES that same row, so the provider sees the same
    // deterministic idempotency identity as the failed attempt.
    expect(txWithKey(key)[0].id).toBe(failedAttemptRowId);
    expect(calls[0].paymentTransactionId).toBe(failedAttemptRowId);
    expect(txWithKey(key)[0].status).toBe('success');
    expect(recordFor(key)?.status).toBe('completed');
    expect(dbState.idempotencyRecords.filter((r) => r.idempotencyKey === key)).toHaveLength(1);

    // And a replay after that returns the cached success, still one charge.
    const replay = await pay(key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(retry.body.id);
    expect(calls.length).toBe(1);
    expect(unhandledRejections).toBe(0);
  });

  it("4b. after a 'failed' attempt, reusing the key with a DIFFERENT body is still rejected", async () => {
    const key = 'p2:failed-mismatch:001';
    const original = RoutingEngine.prototype.routePayment;
    RoutingEngine.prototype.routePayment = async function () {
      throw new Error('simulated routing failure');
    };
    restores.push(() => {
      RoutingEngine.prototype.routePayment = original;
    });
    const first = await pay(key, { amount: 40 });
    expect(first.status).toBe(503);
    RoutingEngine.prototype.routePayment = original;

    const calls = instrumentStripe();
    const second = await pay(key, { amount: 99 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_conflict');
    expect(calls.length).toBe(0);
    // Phase 3: only the first attempt's pre-allocated row exists (still
    // 'failed', original amount) — the conflicting request created nothing.
    expect(txWithKey(key)).toHaveLength(1);
    expect(txWithKey(key)[0].status).toBe('failed');
    expect(txWithKey(key)[0].amount).toBe('40');
  });

  it('idempotency store outage: fails CLOSED with 503, provider never called, gateway keeps serving', async () => {
    const calls = instrumentStripe();
    dbState.failIdempotencyStore = true;
    const res = await pay('p2:outage:001');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('idempotency_unavailable');
    expect(calls.length).toBe(0);
    expect(txWithKey('p2:outage:001')).toHaveLength(0);
    dbState.failIdempotencyStore = false;

    await gatewayStillServing();
    const after = await pay('p2:outage:002');
    expect(after.status).toBe(200);
    expect(unhandledRejections).toBe(0);
  });

  it('payments without an Idempotency-Key are unaffected (two requests, two charges, NULL keys never collide)', async () => {
    const calls = instrumentStripe();
    const a = await pay(undefined);
    const b = await pay(undefined);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).not.toBe(b.body.id);
    expect(calls.length).toBe(2);
  });
});

describe('Phase 2 — refund route shares the same claim path', () => {
  it("reusing a refund key after a 'failed' attempt no longer crashes; a different body under the key is 409", async () => {
    const key = 'p2:refund:001';
    const first = await runtime.post('/refunds', { payment_id: 'ch_does_not_exist_p2' }, { ...AUTH, 'idempotency-key': key });
    expect(first.status).toBe(404);
    expect(recordFor(key, 'refund')?.status).toBe('failed');

    // Previously: bare INSERT on the existing failed row → 23505 → unhandled
    // rejection → gateway process exit.
    const again = await runtime.post('/refunds', { payment_id: 'ch_does_not_exist_p2' }, { ...AUTH, 'idempotency-key': key });
    expect(again.status).toBe(404);

    const different = await runtime.post('/refunds', { payment_id: 'ch_other_p2' }, { ...AUTH, 'idempotency-key': key });
    expect(different.status).toBe(409);
    expect((await different.json()).error.code).toBe('idempotency_conflict');
    expect(unhandledRejections).toBe(0);
    await gatewayStillServing();
  });

  it('a successful refund replays its cached result for the same key and body', async () => {
    const payment = await pay(undefined, { amount: 30 });
    expect(payment.status).toBe(200);
    const key = 'p2:refund:002';
    const body = { payment_id: payment.body.id, amount: 10 };
    const r1 = await runtime.post('/refunds', body, { ...AUTH, 'idempotency-key': key });
    const r2 = await runtime.post('/refunds', body, { ...AUTH, 'idempotency-key': key });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await r2.json()).id).toBe((await r1.json()).id);
  });
});
