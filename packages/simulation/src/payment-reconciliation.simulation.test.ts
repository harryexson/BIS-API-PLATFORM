import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Read at module load by the gateway (ADMIN_API_TOKEN) and by
// @company/routing (PROVIDER_TIMEOUT_MS) — so set before any import.
const ADMIN_TOKEN = vi.hoisted(() => {
  const token = 'p6-reconciliation-admin-token';
  process.env.ADMIN_API_TOKEN = token;
  process.env.PROVIDER_TIMEOUT_MS = '400';
  return token;
});

import { dbState, clearDb, seedReachChurch, installDatabaseMock, API_KEY, TENANT_ID } from './db';

vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, drain, stopWorker, type SimRuntime, type WorkerHandle } from './harness';

/**
 * Phase 6 — the network-death scenario end to end, over HTTP through the
 * REAL gateway, router, adapters and reconciliation job (gap register D4):
 *
 *   provider never answers → 202 'unknown' on the platform's own stable
 *   payment id → row stored as 'unknown' (not 'pending', no random provider
 *   id) → a same-key retry never charges again → the reconciliation job
 *   escalates it WITHOUT any money-moving provider call → it appears on the
 *   operator list → an operator records the verified outcome.
 *
 * The database is the in-memory double (./db.ts) whose transaction methods
 * mirror the real conditional UPDATEs; the real SQL (atomic transitions
 * under real concurrency, the reconciliation queries, migration 0016) is
 * proven on a real Postgres in packages/database/src/payment-*.postgres.
 * integration.test.ts.
 */

let runtime: SimRuntime;
let worker: WorkerHandle;
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const AUTH = { authorization: 'Bearer ' + API_KEY, 'x-tenant-id': TENANT_ID };
const moneyCalls: string[] = [];
const restores: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
  worker = await runtime.makeWorker({});
  for (const cfg of runtime.registry.getAllConfigs().filter((c) => c.category === 'payment')) {
    const p = runtime.registry.getProvider(cfg.id)! as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const method of ['processRequest', 'refund']) {
      const orig = p[method];
      p[method] = function (this: unknown, ...args: unknown[]) {
        moneyCalls.push(`${cfg.id}.${method}`);
        // Stripe: network death — the request went out, no response ever comes back.
        if (cfg.id === 'stripe' && method === 'processRequest') return new Promise(() => {});
        return orig.apply(this, args);
      };
      restores.push(() => {
        p[method] = orig;
      });
    }
  }
}, 30_000);

afterAll(async () => {
  while (restores.length) restores.pop()!();
  await stopWorker(worker);
  await runtime.close();
}, 15_000);

const json = async (res: Response) => (await res.json()) as Record<string, any>;
const pay = (key: string) =>
  runtime.post(
    '/v1/api/gateway/payment',
    { amount: 75, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', paymentToken: 'pm_card_visa' },
    { ...AUTH, 'idempotency-key': key },
  );

describe('Phase 6 — UNKNOWN outcome → reconciliation, through the real gateway and worker', () => {
  let paymentId: string;

  it('a provider timeout returns 202 status unknown on the platform\'s own stable payment id, stored as UNKNOWN (no random provider id)', async () => {
    const res = await pay('order-p6-1');
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.status).toBe('unknown');
    expect(body.paymentTransactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.id).toBe(body.paymentTransactionId);
    paymentId = body.paymentTransactionId;

    const row = dbState.transactions.find((t) => t.id === paymentId)!;
    expect(row.status).toBe('unknown');
    expect(row.providerId).toBe('stripe');
    expect(row.providerTransactionId).toBeNull();
    expect(row.outcomeUnknownAt).toBeInstanceOf(Date);
    expect(row.reconciliationReason).toMatch(/^provider_timeout/);
    expect(moneyCalls).toEqual(['stripe.processRequest']); // no failover to another provider
  });

  it('a same-key retry never charges again — inside the replay window (cached 202) or after it (409)', async () => {
    const replay = await pay('order-p6-1');
    expect(replay.status).toBe(202);
    expect((await json(replay)).id).toBe(paymentId);

    for (const r of dbState.idempotencyRecords) r.expiresAt = new Date(Date.now() - 1000);
    const late = await pay('order-p6-1');
    expect(late.status).toBe(409);
    const body = await json(late);
    expect(body.error.code).toBe('idempotency_conflict');
    expect(body.error.message).toMatch(/outcome is not yet known/);
    expect(body.error.resource).toMatchObject({ paymentTransactionId: paymentId, status: 'unknown' });

    expect(moneyCalls).toEqual(['stripe.processRequest']);
    expect(dbState.transactions.filter((t) => t.idempotencyKey === 'order-p6-1')).toHaveLength(1);
  });

  it('the reconciliation job escalates it for human review with ZERO money-moving provider calls (no adapter here has a usable status query)', async () => {
    const row = dbState.transactions.find((t) => t.id === paymentId)!;
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    row.updatedAt = twoHoursAgo;
    row.outcomeUnknownAt = twoHoursAgo;
    const before = moneyCalls.length;

    await worker.queue.enqueue('reconciliation', {});
    await drain(worker, ['reconciliation']);

    expect(moneyCalls.length).toBe(before);
    expect(row.status).toBe('requires_reconciliation');
    expect(row.reconciliationReason).toMatch(/ambiguous_outcome: provider 'stripe'.*cannot be checked automatically.*Never auto-retried/);
    const audit = dbState.auditLogs.filter((a) => a.action === 'reconciliation').pop()!;
    const report = JSON.parse(audit.details ?? '{}');
    expect(report.payments).toMatchObject({ chargeAttempts: 0, examined: 1 });
    expect(report.payments.escalated).toEqual([expect.objectContaining({ id: paymentId, from: 'unknown' })]);
  });

  it('GET /api/dashboard/payments/reconciliation lists it with full context (admin only)', async () => {
    expect((await runtime.get('/api/dashboard/payments/reconciliation')).status).toBe(403);
    const res = await runtime.get('/api/dashboard/payments/reconciliation', ADMIN);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.counts).toMatchObject({ requires_reconciliation: 1 });
    const item = body.data.find((d: any) => d.paymentTransactionId === paymentId);
    expect(item).toMatchObject({
      providerId: 'stripe',
      providerTransactionId: null,
      status: 'requires_reconciliation',
      amount: 75,
      currency: 'USD',
      idempotencyKey: 'order-p6-1',
    });
    expect(item.stuckForSeconds).toBeGreaterThanOrEqual(0);
    expect(item.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(item.reconciliationReason).toMatch(/Never auto-retried/);
    expect(item.outcomeUnknownAt).toBeTruthy();
  });

  it('an operator records the verified outcome; invalid/duplicate resolutions are refused and never touch a provider', async () => {
    const before = moneyCalls.length;
    const url = `/api/dashboard/payments/reconciliation/${paymentId}/resolve`;
    expect((await runtime.post(url, { status: 'success', note: 'x', resolvedBy: 'ops' })).status).toBe(403);
    expect((await runtime.post(url, { status: 'refunded', note: 'x', resolvedBy: 'ops' }, ADMIN)).status).toBe(400);
    expect((await runtime.post(url, { status: 'success', resolvedBy: 'ops' }, ADMIN)).status).toBe(400);
    // Phase 20-21 (PHASE6-03 / C7): a missing body `resolvedBy` used to be a
    // 400 — the shared admin token carried no identity, so the operator had
    // to name themselves. resolvedBy is now the AUTHENTICATED admin, so it is
    // no longer a request field (the self-declared one below is ignored).
    expect((await runtime.post('/api/dashboard/payments/reconciliation/not-a-uuid/resolve', { status: 'success', note: 'x', resolvedBy: 'ops' }, ADMIN)).status).toBe(400);
    expect((await runtime.post(`/api/dashboard/payments/reconciliation/${crypto.randomUUID()}/resolve`, { status: 'success', note: 'x', resolvedBy: 'ops' }, ADMIN)).status).toBe(404);

    const ok = await runtime.post(
      url,
      { status: 'success', providerTransactionId: 'pi_found_in_dashboard', note: 'Confirmed succeeded in the Stripe dashboard', resolvedBy: 'ops@reach' },
      ADMIN,
    );
    expect(ok.status).toBe(200);
    const row = dbState.transactions.find((t) => t.id === paymentId)!;
    expect(row.status).toBe('success');
    expect(row.providerTransactionId).toBe('pi_found_in_dashboard');
    // The body claimed resolvedBy 'ops@reach'; the record names the admin
    // credential that actually made the request (this suite boots with the
    // legacy ADMIN_API_TOKEN, whose identity is 'legacy-admin-token').
    expect(row.reconciliationResolution).toMatchObject({ source: 'operator', resolvedBy: 'legacy-admin-token', resolvedStatus: 'success' });
    expect(JSON.stringify(row.reconciliationResolution)).not.toContain('ops@reach');

    const again = await runtime.post(url, { status: 'failed', note: 'oops', resolvedBy: 'ops' }, ADMIN);
    expect(again.status).toBe(409);
    expect((await json(again)).status).toBe('success');
    expect(row.status).toBe('success');
    expect(moneyCalls.length).toBe(before);
  });
});
