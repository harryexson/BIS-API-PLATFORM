import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, dbState, installDatabaseMock, seedReachChurch, APP_SLUG } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including the new refund route — is the REAL
// code (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, createDonation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Payment refunds (POST /v1/api/gateway/refund)\n`);

let runtime: SimRuntime;

const HEADERS = {
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': 'ten_reach_church',
};

const OTHER_APP_HEADERS = {
  authorization: 'Bearer bap_test_haulpro_0001',
  'x-tenant-id': 'ten_haulpro',
};

beforeAll(async () => {
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

beforeEach(() => {
  clearDb();
  seedReachChurch();
});

describe('POST /v1/api/gateway/refund', () => {
  it('refunds a successful payment end-to-end, transitioning the transaction to refunded', async () => {
    const donation = await createDonation(runtime, { amount: 25, providerOverride: 'stripe' });
    expect(donation.status).toBe(200);
    expect(donation.body.status).toBe('success');

    const before = dbState.transactions.find((t) => t.providerTransactionId === donation.txId);
    expect(before?.status).toBe('success');

    const res = await runtime.post('/v1/api/gateway/refund', { transactionId: donation.txId }, HEADERS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.amount).toBe(25);

    const after = dbState.transactions.find((t) => t.providerTransactionId === donation.txId);
    expect(after?.status).toBe('refunded');
  });

  it('supports a partial refund without exceeding the original amount', async () => {
    const donation = await createDonation(runtime, { amount: 50, providerOverride: 'stripe' });
    const res = await runtime.post('/v1/api/gateway/refund', { transactionId: donation.txId, amount: 20 }, HEADERS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.amount).toBe(20);
  });

  it('400s when the requested refund amount exceeds the original transaction amount', async () => {
    const donation = await createDonation(runtime, { amount: 10, providerOverride: 'stripe' });
    const res = await runtime.post('/v1/api/gateway/refund', { transactionId: donation.txId, amount: 999 }, HEADERS);

    expect(res.status).toBe(400);
    const before = dbState.transactions.find((t) => t.providerTransactionId === donation.txId);
    expect(before?.status).toBe('success');
  });

  it('409s on a transaction that is not (or no longer) success', async () => {
    const donation = await createDonation(runtime, { amount: 10, providerOverride: 'stripe' });
    await runtime.post('/v1/api/gateway/refund', { transactionId: donation.txId }, HEADERS);

    // Already refunded — a second refund attempt must not silently double-refund.
    const res = await runtime.post('/v1/api/gateway/refund', { transactionId: donation.txId }, HEADERS);
    expect(res.status).toBe(409);
  });

  it('404s for a transaction that does not exist', async () => {
    const res = await runtime.post('/v1/api/gateway/refund', { transactionId: 'pi_does_not_exist' }, HEADERS);
    expect(res.status).toBe(404);
  });

  it('404s when a different application tries to refund a transaction it does not own', async () => {
    const donation = await createDonation(runtime, { amount: 10, providerOverride: 'stripe' });

    const res = await runtime.post('/v1/api/gateway/refund', { transactionId: donation.txId }, OTHER_APP_HEADERS);
    expect(res.status).toBe(404);

    const after = dbState.transactions.find((t) => t.providerTransactionId === donation.txId);
    expect(after?.status).toBe('success');
  });

  it('400s when transactionId is missing', async () => {
    const res = await runtime.post('/v1/api/gateway/refund', {}, HEADERS);
    expect(res.status).toBe(400);
  });
});
