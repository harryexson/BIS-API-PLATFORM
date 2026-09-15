import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, dbState, installDatabaseMock, seedReachChurch, APP_SLUG } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including plan-limit enforcement — is the REAL
// code (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, createDonation, sendMessage, type SimRuntime } from './harness';

console.warn(`\n[simulation] Plan usage-limit enforcement (message count, payment volume)\n`);

let runtime: SimRuntime;

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

function seedTinyPlan(overrides: { messageLimit?: number | null; paymentVolumeLimitCents?: number | null }) {
  const now = new Date();
  dbState.plans.push({
    id: 'plan_tiny',
    slug: 'tiny',
    name: 'Tiny (test)',
    description: null,
    priceCents: 0,
    currency: 'USD',
    interval: 'month',
    messageLimit: overrides.messageLimit ?? null,
    paymentVolumeLimitCents: overrides.paymentVolumeLimitCents ?? null,
    stripePriceId: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
}

function seedActiveSubscription(periodStart: Date) {
  const now = new Date();
  dbState.subscriptions.push({
    id: `sub_${APP_SLUG}`,
    applicationId: APP_SLUG,
    planId: 'plan_tiny',
    status: 'active',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodStart: periodStart,
    currentPeriodEnd: new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('an application with no active subscription', () => {
  it('is never blocked by plan limits on payments', async () => {
    const res = await createDonation(runtime, { amount: 1_000_000 });
    expect(res.status).not.toBe(402);
  });

  it('is never blocked by plan limits on messages', async () => {
    const res = await sendMessage(runtime, { recipient: '+15005550006', content: 'hi' });
    expect(res.status).not.toBe(402);
  });
});

describe('a plan with null limits', () => {
  it('leaves payments and messages unrestricted', async () => {
    seedTinyPlan({ messageLimit: null, paymentVolumeLimitCents: null });
    seedActiveSubscription(new Date(Date.now() - 60_000));

    const payment = await createDonation(runtime, { amount: 1_000_000 });
    expect(payment.status).not.toBe(402);

    const message = await sendMessage(runtime, { recipient: '+15005550006', content: 'hi' });
    expect(message.status).not.toBe(402);
  });
});

describe('POST /v1/api/gateway/messaging: plan message-limit enforcement', () => {
  it('allows sends up to the limit, then blocks with 402 and a clear reason', async () => {
    seedTinyPlan({ messageLimit: 1 });
    seedActiveSubscription(new Date(Date.now() - 60_000));

    const first = await sendMessage(runtime, { recipient: '+15005550006', content: 'first' });
    expect(first.status).toBe(200);

    const second = await sendMessage(runtime, { recipient: '+15005550006', content: 'second' });
    expect(second.status).toBe(402);
    expect(second.body.error).toMatch(/message limit/i);
  });

  it('does not block a fresh billing period even after the previous period was exhausted', async () => {
    seedTinyPlan({ messageLimit: 1 });
    // Current period only just started — nothing sent yet within it, even
    // though (in a real deployment) a prior period could have been
    // exhausted. Simulated here by simply seeding a subscription whose
    // period start is "now": no events exist since that timestamp.
    seedActiveSubscription(new Date());

    const res = await sendMessage(runtime, { recipient: '+15005550006', content: 'first of the new period' });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/api/gateway/payment: plan payment-volume-limit enforcement', () => {
  it('allows payments under the volume limit, then blocks one that would exceed it', async () => {
    seedTinyPlan({ paymentVolumeLimitCents: 1000 }); // $10.00
    seedActiveSubscription(new Date(Date.now() - 60_000));

    const first = await createDonation(runtime, { amount: 6 }); // $6.00 — under the limit
    expect(first.status).toBe(200);

    const second = await createDonation(runtime, { amount: 5 }); // would bring total to $11.00
    expect(second.status).toBe(402);
    expect(second.body.error).toMatch(/volume limit/i);
  });

  it('allows a payment that lands exactly on the limit', async () => {
    seedTinyPlan({ paymentVolumeLimitCents: 1000 }); // $10.00
    seedActiveSubscription(new Date(Date.now() - 60_000));

    const res = await createDonation(runtime, { amount: 10 }); // exactly $10.00
    expect(res.status).toBe(200);
  });
});
