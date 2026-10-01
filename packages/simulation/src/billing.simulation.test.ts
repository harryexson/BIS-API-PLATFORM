import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { dbState, clearDb, seedPlans, installDatabaseMock } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including the new billing routes — is the REAL code
// (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Subscriptions/billing — plans, subscribe, cancel, Stripe webhook sync\n`);

let runtime: SimRuntime;

beforeAll(async () => {
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = 'sim-billing-webhook-secret';
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

beforeEach(() => {
  clearDb();
  seedPlans();
});

async function signupAndLogin() {
  const signupRes = await runtime.post('/v1/api/auth/signup', {
    email: 'owner@reachchurch.example',
    password: 'correct-horse-battery-staple',
    applicationName: 'Reach Church',
    applicationSlug: 'reach-church',
  });
  const signupBody = await signupRes.json();
  const loginRes = await runtime.post('/v1/api/auth/login', {
    email: 'owner@reachchurch.example',
    password: 'correct-horse-battery-staple',
  });
  const { token } = await loginRes.json();
  return { token, applicationId: signupBody.application.id as string };
}

describe('GET /v1/api/billing/plans', () => {
  it('lists the seeded active plans without requiring auth', async () => {
    const res = await runtime.get('/v1/api/billing/plans');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plans.map((p: any) => p.slug).sort()).toEqual(['enterprise', 'growth', 'starter']);
  });
});

describe('billing subscribe / cancel (session-authed)', () => {
  it('rejects without a session', async () => {
    const res = await runtime.post('/v1/api/billing/subscribe', { planSlug: 'growth' });
    expect(res.status).toBe(401);
  });

  it('subscribes the signed-up application to a plan', async () => {
    const { token } = await signupAndLogin();
    const res = await runtime.post(
      '/v1/api/billing/subscribe',
      { planSlug: 'growth' },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.stripeSubscriptionId).toMatch(/^sim_sub_/);
  });

  it('rejects an unknown plan slug with 400', async () => {
    const { token } = await signupAndLogin();
    const res = await runtime.post(
      '/v1/api/billing/subscribe',
      { planSlug: 'not-a-real-plan' },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(400);
  });

  it('GET /subscription reflects the current plan and null before subscribing', async () => {
    const { token } = await signupAndLogin();

    const before = await runtime.get('/v1/api/billing/subscription', { authorization: `Bearer ${token}` });
    expect((await before.json()).subscription).toBeNull();

    await runtime.post('/v1/api/billing/subscribe', { planSlug: 'starter' }, { authorization: `Bearer ${token}` });
    const after = await runtime.get('/v1/api/billing/subscription', { authorization: `Bearer ${token}` });
    const afterBody = await after.json();
    expect(afterBody.subscription.status).toBe('active');
  });

  it('changing plans updates the same subscription rather than creating a second one', async () => {
    const { token, applicationId } = await signupAndLogin();
    await runtime.post('/v1/api/billing/subscribe', { planSlug: 'starter' }, { authorization: `Bearer ${token}` });
    await runtime.post('/v1/api/billing/subscribe', { planSlug: 'enterprise' }, { authorization: `Bearer ${token}` });

    const matching = dbState.subscriptions.filter((s) => s.applicationId === applicationId);
    expect(matching).toHaveLength(1);
    const enterprisePlan = dbState.plans.find((p) => p.slug === 'enterprise')!;
    expect(matching[0].planId).toBe(enterprisePlan.id);
  });

  it('cancels immediately by default is false — atPeriodEnd defaults to true', async () => {
    const { token } = await signupAndLogin();
    await runtime.post('/v1/api/billing/subscribe', { planSlug: 'growth' }, { authorization: `Bearer ${token}` });

    const res = await runtime.post('/v1/api/billing/cancel', {}, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.cancelAtPeriodEnd).toBe(true);
  });

  it('cancels immediately when atPeriodEnd: false is passed explicitly', async () => {
    const { token } = await signupAndLogin();
    await runtime.post('/v1/api/billing/subscribe', { planSlug: 'growth' }, { authorization: `Bearer ${token}` });

    const res = await runtime.post(
      '/v1/api/billing/cancel',
      { atPeriodEnd: false },
      { authorization: `Bearer ${token}` },
    );
    const body = await res.json();
    expect(body.subscription.status).toBe('canceled');
  });

  it('rejects canceling with no subscription with 400', async () => {
    const { token } = await signupAndLogin();
    const res = await runtime.post('/v1/api/billing/cancel', {}, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/api/billing/webhooks/stripe', () => {
  function signStripePayload(rawBody: string, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  it('rejects a missing signature with 401', async () => {
    const res = await runtime.post('/v1/api/billing/webhooks/stripe', {
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_x' } },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid signature with 401', async () => {
    const res = await runtime.post(
      '/v1/api/billing/webhooks/stripe',
      { type: 'customer.subscription.updated', data: { object: { id: 'sub_x' } } },
      { 'stripe-signature': 't=1,v1=deadbeef' },
    );
    expect(res.status).toBe(401);
  });

  it('accepts a correctly-signed event and syncs subscription status', async () => {
    const { token } = await signupAndLogin();
    const subRes = await runtime.post(
      '/v1/api/billing/subscribe',
      { planSlug: 'growth' },
      { authorization: `Bearer ${token}` },
    );
    const { subscription } = await subRes.json();

    const payload = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: { id: subscription.stripeSubscriptionId, status: 'past_due', cancel_at_period_end: false } },
    });
    const signature = signStripePayload(payload, 'sim-billing-webhook-secret');

    const webhookRes = await runtime.postText('/v1/api/billing/webhooks/stripe', payload, {
      'stripe-signature': signature,
    });
    expect(webhookRes.status).toBe(200);

    const afterRes = await runtime.get('/v1/api/billing/subscription', { authorization: `Bearer ${token}` });
    const afterBody = await afterRes.json();
    expect(afterBody.subscription.status).toBe('past_due');
  });
});
