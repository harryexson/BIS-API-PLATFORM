import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, seedPlans, installDatabaseMock } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway — is the REAL code (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Admin console Request Playground dispatch (admin-gated)\n`);

const ADMIN_TOKEN = 'sim-admin-token';

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
  seedPlans();
});

const ADMIN = { 'x-admin-token': ADMIN_TOKEN };

describe('POST /api/dashboard/playground/dispatch', () => {
  it('requires admin auth', async () => {
    const res = await runtime.post('/api/dashboard/playground/dispatch', { category: 'payment', appId: 'testapp' });
    expect(res.status).toBe(403);
  });

  it('400s when appId or category is missing', async () => {
    const res = await runtime.post('/api/dashboard/playground/dispatch', { category: 'payment' }, ADMIN);
    expect(res.status).toBe(400);
  });

  it('400s for an unknown category', async () => {
    const res = await runtime.post('/api/dashboard/playground/dispatch', { category: 'bogus', appId: 'testapp' }, ADMIN);
    expect(res.status).toBe(400);
  });

  it('dispatches a payment request through the real routing engine, same as the API-key route', async () => {
    const res = await runtime.post(
      '/api/dashboard/playground/dispatch',
      { category: 'payment', appId: 'testapp', amount: 100, currency: 'USD', paymentMethod: 'card' },
      ADMIN,
    );
    expect([200, 202]).toContain(res.status);
    const body = await res.json();
    expect(body.category).toBe('payment');
    expect(body.appId).toBe('testapp');
    expect(['success', 'failed', 'unknown']).toContain(body.status);
  });

  it('passes paymentToken through to the provider — this is the one real caller in the whole platform that can supply one', async () => {
    const res = await runtime.post(
      '/api/dashboard/playground/dispatch',
      { category: 'payment', appId: 'testapp', amount: 100, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_test_visa' },
      ADMIN,
    );
    const body = await res.json();
    // No real STRIPE_SECRET_KEY is configured in this test env, so the
    // Stripe adapter still falls back to simulated — but the payload it
    // fell back *from* must still carry the token untouched, proving the
    // dispatch route didn't drop it along the way.
    expect(body.payload.paymentToken).toBe('pm_test_visa');
  });

  it('dispatches a messaging request through the real routing engine', async () => {
    const res = await runtime.post(
      '/api/dashboard/playground/dispatch',
      { category: 'messaging', appId: 'testapp', recipient: '+15005550006', content: 'hello from the playground' },
      ADMIN,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('messaging');
  });

  it('dispatches an "other" (maps/identity/ai) request through the real routing engine', async () => {
    const res = await runtime.post(
      '/api/dashboard/playground/dispatch',
      { category: 'other', appId: 'testapp', serviceType: 'ai', payload: { prompt: 'hello' } },
      ADMIN,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('other');
  });

  it('emits the dispatched event onto the same event bus real traffic uses, so it shows up in Observability/AuditLogs', async () => {
    const before = await (await runtime.get('/api/dashboard/logs', ADMIN)).json();
    await runtime.post(
      '/api/dashboard/playground/dispatch',
      { category: 'payment', appId: 'playground-visibility-test', amount: 50, currency: 'USD', paymentMethod: 'card' },
      ADMIN,
    );
    const after = await (await runtime.get('/api/dashboard/logs', ADMIN)).json();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((e: any) => e.appId === 'playground-visibility-test')).toBe(true);
  });
});
