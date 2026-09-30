import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SubscriptionRegistry,
  SubscriptionError,
  type PlanRecord,
  type SubscriptionRecord,
  type PlanRepositoryForBilling,
  type SubscriptionRepositoryForBilling,
  type ApplicationLookupForBilling,
} from './subscription-registry';

function makePlan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'plan-growth',
    slug: 'growth',
    name: 'Growth',
    description: null,
    priceCents: 4900,
    currency: 'USD',
    interval: 'month',
    messageLimit: 25_000,
    paymentVolumeLimitCents: 5_000_000,
    stripePriceId: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockPlanRepo(plans: PlanRecord[]): PlanRepositoryForBilling {
  return {
    async findBySlug(slug) {
      return plans.find((p) => p.slug === slug);
    },
    async findById(id) {
      return plans.find((p) => p.id === id);
    },
    async listActive() {
      return plans.filter((p) => p.isActive);
    },
  };
}

function createMockSubscriptionRepo(): SubscriptionRepositoryForBilling & { _rows: SubscriptionRecord[] } {
  const rows: SubscriptionRecord[] = [];
  let seq = 0;
  return {
    _rows: rows,
    async findByApplicationId(applicationId) {
      return rows.find((r) => r.applicationId === applicationId);
    },
    async findByStripeSubscriptionId(stripeSubscriptionId) {
      return rows.find((r) => r.stripeSubscriptionId === stripeSubscriptionId);
    },
    async create(data) {
      const row: SubscriptionRecord = {
        id: 'sub-row-' + String(++seq).padStart(3, '0'),
        applicationId: data.applicationId,
        planId: data.planId,
        status: (data.status as string) ?? 'active',
        stripeCustomerId: (data.stripeCustomerId as string) ?? null,
        stripeSubscriptionId: (data.stripeSubscriptionId as string) ?? null,
        currentPeriodStart: (data.currentPeriodStart as Date) ?? null,
        currentPeriodEnd: (data.currentPeriodEnd as Date) ?? null,
        cancelAtPeriodEnd: (data.cancelAtPeriodEnd as boolean) ?? false,
        canceledAt: (data.canceledAt as Date) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(row);
      return row;
    },
    async update(id, data) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) return undefined;
      rows[idx] = { ...rows[idx], ...data, updatedAt: new Date() } as SubscriptionRecord;
      return rows[idx];
    },
  };
}

function createMockApplicationRepo(): ApplicationLookupForBilling {
  return {
    async findById(applicationId) {
      if (applicationId === 'app-1') return { id: 'app-1', name: 'Reach Church' };
      return undefined;
    },
  };
}

describe('SubscriptionRegistry (simulated mode — no STRIPE_SECRET_KEY)', () => {
  const originalKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
  });

  function build(plans: PlanRecord[] = [makePlan()]) {
    const planRepo = createMockPlanRepo(plans);
    const subscriptionRepo = createMockSubscriptionRepo();
    const applicationRepo = createMockApplicationRepo();
    const registry = new SubscriptionRegistry(planRepo, subscriptionRepo, applicationRepo);
    return { registry, subscriptionRepo };
  }

  it('lists only active plans', async () => {
    const { registry } = build([makePlan(), makePlan({ id: 'plan-2', slug: 'inactive', isActive: false })]);
    const plans = await registry.listPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].slug).toBe('growth');
  });

  it('subscribes an application to a plan with a fabricated-but-labeled subscription id', async () => {
    const { registry } = build();
    const sub = await registry.subscribe('app-1', 'growth', 'owner@reachchurch.example');
    expect(sub.status).toBe('active');
    expect(sub.stripeSubscriptionId).toMatch(/^sim_sub_/);
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an unknown application', async () => {
    const { registry } = build();
    await expect(registry.subscribe('nope', 'growth', 'x@example.com')).rejects.toThrow(SubscriptionError);
  });

  it('rejects an unknown or inactive plan', async () => {
    const { registry } = build([makePlan({ isActive: false })]);
    await expect(registry.subscribe('app-1', 'growth', 'x@example.com')).rejects.toThrow(SubscriptionError);
    await expect(registry.subscribe('app-1', 'no-such-plan', 'x@example.com')).rejects.toThrow(SubscriptionError);
  });

  it('changing plan updates the existing subscription row instead of creating a second one', async () => {
    const { registry, subscriptionRepo } = build([
      makePlan(),
      makePlan({ id: 'plan-enterprise', slug: 'enterprise', priceCents: 19_900 }),
    ]);
    await registry.subscribe('app-1', 'growth', 'x@example.com');
    await registry.subscribe('app-1', 'enterprise', 'x@example.com');

    expect(subscriptionRepo._rows).toHaveLength(1);
    expect(subscriptionRepo._rows[0].planId).toBe('plan-enterprise');
  });

  it('reuses the same simulated Stripe customer id across a plan change', async () => {
    const { registry } = build([
      makePlan(),
      makePlan({ id: 'plan-enterprise', slug: 'enterprise' }),
    ]);
    const first = await registry.subscribe('app-1', 'growth', 'x@example.com');
    const second = await registry.subscribe('app-1', 'enterprise', 'x@example.com');
    expect(second.stripeCustomerId).toBe(first.stripeCustomerId);
  });

  it('cancels immediately when atPeriodEnd is false', async () => {
    const { registry } = build();
    await registry.subscribe('app-1', 'growth', 'x@example.com');
    const canceled = await registry.cancelSubscription('app-1', false);
    expect(canceled.status).toBe('canceled');
    expect(canceled.canceledAt).toBeInstanceOf(Date);
  });

  it('schedules cancellation at period end without changing status yet', async () => {
    const { registry } = build();
    await registry.subscribe('app-1', 'growth', 'x@example.com');
    const scheduled = await registry.cancelSubscription('app-1', true);
    expect(scheduled.status).toBe('active');
    expect(scheduled.cancelAtPeriodEnd).toBe(true);
  });

  it('rejects canceling when there is no subscription', async () => {
    const { registry } = build();
    await expect(registry.cancelSubscription('app-1', false)).rejects.toThrow(SubscriptionError);
  });

  it('getSubscription returns the current row, or undefined if none exists', async () => {
    const { registry } = build();
    expect(await registry.getSubscription('app-1')).toBeUndefined();
    await registry.subscribe('app-1', 'growth', 'x@example.com');
    expect((await registry.getSubscription('app-1'))?.status).toBe('active');
  });
});

describe('SubscriptionRegistry.syncFromStripeEvent', () => {
  function build() {
    const subscriptionRepo = createMockSubscriptionRepo();
    const registry = new SubscriptionRegistry(
      createMockPlanRepo([makePlan()]),
      subscriptionRepo,
      createMockApplicationRepo(),
    );
    return { registry, subscriptionRepo };
  }

  it('updates status from customer.subscription.updated', async () => {
    const { registry, subscriptionRepo } = build();
    await subscriptionRepo.create({
      applicationId: 'app-1',
      planId: 'plan-growth',
      status: 'active',
      stripeSubscriptionId: 'sub_real123',
    });

    const updated = await registry.syncFromStripeEvent({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_real123', status: 'past_due', cancel_at_period_end: false } },
    });
    expect(updated?.status).toBe('past_due');
  });

  it('marks canceled on customer.subscription.deleted', async () => {
    const { registry, subscriptionRepo } = build();
    await subscriptionRepo.create({
      applicationId: 'app-1',
      planId: 'plan-growth',
      status: 'active',
      stripeSubscriptionId: 'sub_real456',
    });

    const updated = await registry.syncFromStripeEvent({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_real456' } },
    });
    expect(updated?.status).toBe('canceled');
  });

  it('marks past_due on invoice.payment_failed', async () => {
    const { registry, subscriptionRepo } = build();
    await subscriptionRepo.create({
      applicationId: 'app-1',
      planId: 'plan-growth',
      status: 'active',
      stripeSubscriptionId: 'sub_real789',
    });

    const updated = await registry.syncFromStripeEvent({
      type: 'invoice.payment_failed',
      data: { object: { subscription: 'sub_real789' } },
    });
    expect(updated?.status).toBe('past_due');
  });

  it('returns null for an unrecognized event type', async () => {
    const { registry } = build();
    const result = await registry.syncFromStripeEvent({
      type: 'charge.succeeded',
      data: { object: {} },
    });
    expect(result).toBeNull();
  });

  it('returns null when the subscription id is not locally known', async () => {
    const { registry } = build();
    const result = await registry.syncFromStripeEvent({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_unknown', status: 'active' } },
    });
    expect(result).toBeNull();
  });
});
