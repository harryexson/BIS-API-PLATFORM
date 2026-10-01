import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, dbState, installDatabaseMock } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including the new reconciliation route — is the
// REAL code (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Payment reconciliation (GET /api/dashboard/reconciliation)\n`);

const ADMIN_TOKEN = 'sim-admin-token';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };

let runtime: SimRuntime;

beforeAll(async () => {
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

beforeEach(() => {
  clearDb();
});

function pushTransaction(overrides: Partial<(typeof dbState.transactions)[number]> = {}) {
  const now = new Date();
  dbState.transactions.push({
    id: `tx_${Math.random().toString(36).slice(2, 10)}`,
    appId: 'reach-church',
    tenantId: 'ten_reach_church',
    providerId: 'flutterwave',
    providerTransactionId: 'flw-abc123',
    status: 'pending',
    amount: '25.00',
    currency: 'NGN',
    paymentMethod: null,
    idempotencyKey: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe('GET /api/dashboard/reconciliation', () => {
  it('requires admin auth', async () => {
    const res = await runtime.get('/api/dashboard/reconciliation');
    expect(res.status).toBe(403);
  });

  it('reports a transaction stuck in pending past the threshold', async () => {
    pushTransaction({ status: 'pending', updatedAt: new Date(Date.now() - 2 * 60 * 60_000) });

    const res = await runtime.get('/api/dashboard/reconciliation?thresholdMs=3600000', ADMIN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.staleCount).toBe(1);
    expect(body.stale[0].providerId).toBe('flutterwave');
    expect(body.stale[0].status).toBe('pending');
  });

  it('does not report a recent pending transaction (still within the settlement window)', async () => {
    pushTransaction({ status: 'pending', updatedAt: new Date() });

    const res = await runtime.get('/api/dashboard/reconciliation?thresholdMs=3600000', ADMIN);
    const body = await res.json();

    expect(body.staleCount).toBe(0);
  });

  it('does not report a resolved (success/failed/refunded) transaction regardless of age', async () => {
    pushTransaction({ status: 'success', updatedAt: new Date(Date.now() - 24 * 60 * 60_000) });
    pushTransaction({ status: 'failed', updatedAt: new Date(Date.now() - 24 * 60 * 60_000) });
    pushTransaction({ status: 'refunded', updatedAt: new Date(Date.now() - 24 * 60 * 60_000) });

    const res = await runtime.get('/api/dashboard/reconciliation?thresholdMs=3600000', ADMIN);
    const body = await res.json();

    expect(body.staleCount).toBe(0);
  });

  it('reports an unknown (ambiguous timeout) transaction past the threshold too', async () => {
    pushTransaction({ status: 'unknown', updatedAt: new Date(Date.now() - 2 * 60 * 60_000) });

    const res = await runtime.get('/api/dashboard/reconciliation?thresholdMs=3600000', ADMIN);
    const body = await res.json();

    expect(body.staleCount).toBe(1);
    expect(body.stale[0].status).toBe('unknown');
  });
});
