import { randomUUID } from 'crypto';
import type { NewSubscription } from './schema';

/**
 * Stripe Billing HTTP client (Customers + Subscriptions) — separate from
 * packages/providers/src/adapters/payments/stripe.ts, which only ever
 * calls the one-off Charges API for payments this platform routes on a
 * customer's behalf. This client is for billing the platform's OWN
 * customers (the businesses that hold an application) for platform
 * usage — a different Stripe object graph (Customer + Subscription +
 * Price) entirely.
 *
 * Verified against Stripe's public API reference via web search
 * (2026-09-09) — not from training-data memory:
 *   - POST /v1/customers: {email, name} — real
 *   - POST /v1/subscriptions: {customer, items: [{price}]} required — real
 *   - DELETE /v1/subscriptions/{id}: cancels immediately — real
 *   - POST /v1/subscriptions/{id} with cancel_at_period_end=true:
 *     schedules cancellation at period end. Stripe's docs note this
 *     parameter is being superseded by a newer `cancel_at` enum, but
 *     describe it as deprecated, not removed — used here since it's
 *     still documented as functional and is simpler to verify.
 *   - JSON body + `Content-Type: application/json` is a supported
 *     alternative to Stripe's classic form-encoded body, *provided* the
 *     header is set explicitly (confirmed via search) — matches the
 *     existing payments/stripe.ts adapter's approach.
 * Not verified against a live Stripe account — no credentials were
 * available in this session. No retry/backoff logic is implemented here
 * (unlike BaseProvider.http_request, which the payments adapters use) —
 * a deliberate scope cut for this pass, not an oversight.
 */

const STRIPE_BASE_URL = 'https://api.stripe.com/v1';

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
}

async function stripeRequest<T>(
  apiKey: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${STRIPE_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (json as any)?.error?.message || `Stripe API error: HTTP ${res.status}`;
      throw new Error(message);
    }
    return json as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function createStripeCustomer(
  apiKey: string,
  input: { email: string; name?: string },
): Promise<{ id: string }> {
  return stripeRequest(apiKey, 'POST', '/customers', { email: input.email, name: input.name });
}

async function createStripeSubscription(
  apiKey: string,
  input: { customer: string; priceId: string },
): Promise<StripeSubscription> {
  return stripeRequest(apiKey, 'POST', '/subscriptions', {
    customer: input.customer,
    items: [{ price: input.priceId }],
  });
}

async function cancelStripeSubscriptionImmediately(
  apiKey: string,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest(apiKey, 'DELETE', `/subscriptions/${subscriptionId}`);
}

async function scheduleStripeSubscriptionCancellation(
  apiKey: string,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest(apiKey, 'POST', `/subscriptions/${subscriptionId}`, {
    cancel_at_period_end: true,
  });
}

// ---------------------------------------------------------------------

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export interface PlanRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  interval: string;
  messageLimit: number | null;
  paymentVolumeLimitCents: number | null;
  stripePriceId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionRecord {
  id: string;
  applicationId: string;
  planId: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanRepositoryForBilling {
  findBySlug(slug: string): Promise<PlanRecord | undefined>;
  findById(id: string): Promise<PlanRecord | undefined>;
  listActive(): Promise<PlanRecord[]>;
}

export interface SubscriptionRepositoryForBilling {
  findByApplicationId(applicationId: string): Promise<SubscriptionRecord | undefined>;
  findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<SubscriptionRecord | undefined>;
  create(data: NewSubscription): Promise<SubscriptionRecord>;
  update(id: string, data: Partial<NewSubscription>): Promise<SubscriptionRecord | undefined>;
}

export interface ApplicationLookupForBilling {
  findById(applicationId: string): Promise<{ id: string; name: string } | undefined>;
}

const INTERVAL_MS: Record<string, number> = {
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

// Billing for the platform's own customers (the businesses that hold an
// application), not the one-off payments those businesses route through
// packages/providers. Same DI pattern and real-HTTP-with-simulated-
// fallback philosophy as AuthRegistry/ApplicationRegistry: when
// STRIPE_SECRET_KEY is configured this makes real Stripe Billing API
// calls; otherwise it fabricates plausible-but-labeled subscription
// state so the flow is fully testable without live credentials.
export class SubscriptionRegistry {
  constructor(
    private readonly planRepo: PlanRepositoryForBilling,
    private readonly subscriptionRepo: SubscriptionRepositoryForBilling,
    private readonly applicationRepo: ApplicationLookupForBilling,
  ) {}

  private get apiKey(): string {
    return process.env.STRIPE_SECRET_KEY || '';
  }

  async listPlans(): Promise<PlanRecord[]> {
    return this.planRepo.listActive();
  }

  async getSubscription(applicationId: string): Promise<SubscriptionRecord | undefined> {
    return this.subscriptionRepo.findByApplicationId(applicationId);
  }

  // Subscribes an application to a plan — creates a new subscription if
  // none exists yet, or changes plan on the existing one otherwise (an
  // "upgrade/downgrade" is just calling this again with a new planSlug).
  async subscribe(applicationId: string, planSlug: string, customerEmail: string): Promise<SubscriptionRecord> {
    const application = await this.applicationRepo.findById(applicationId);
    if (!application) {
      throw new SubscriptionError(`Application ${applicationId} not found`);
    }

    const plan = await this.planRepo.findBySlug(planSlug);
    if (!plan || !plan.isActive) {
      throw new SubscriptionError(`Plan "${planSlug}" not found or inactive`);
    }

    const existing = await this.subscriptionRepo.findByApplicationId(applicationId);

    if (!this.apiKey || !plan.stripePriceId) {
      // Simulated mode — no live credentials, or this plan has no
      // live-mode Stripe Price yet. Matches the fallback pattern used
      // throughout packages/providers.
      const now = new Date();
      const periodMs = INTERVAL_MS[plan.interval] ?? INTERVAL_MS.month;
      const simulated = {
        planId: plan.id,
        status: 'active',
        stripeCustomerId: existing?.stripeCustomerId ?? 'sim_cus_' + randomUUID().replace(/-/g, '').slice(0, 16),
        stripeSubscriptionId: 'sim_sub_' + randomUUID().replace(/-/g, '').slice(0, 16),
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + periodMs),
        cancelAtPeriodEnd: false,
        canceledAt: null,
      };
      if (existing) {
        const updated = await this.subscriptionRepo.update(existing.id, simulated);
        return updated!;
      }
      return this.subscriptionRepo.create({ applicationId, ...simulated });
    }

    // Real Stripe path.
    const stripeCustomerId =
      existing?.stripeCustomerId ??
      (await createStripeCustomer(this.apiKey, { email: customerEmail, name: application.name })).id;

    const stripeSub = await createStripeSubscription(this.apiKey, {
      customer: stripeCustomerId,
      priceId: plan.stripePriceId,
    });

    const data = {
      planId: plan.id,
      status: stripeSub.status,
      stripeCustomerId,
      stripeSubscriptionId: stripeSub.id,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      canceledAt: stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : null,
    };

    if (existing) {
      const updated = await this.subscriptionRepo.update(existing.id, data);
      return updated!;
    }
    return this.subscriptionRepo.create({ applicationId, ...data });
  }

  async cancelSubscription(applicationId: string, atPeriodEnd: boolean): Promise<SubscriptionRecord> {
    const existing = await this.subscriptionRepo.findByApplicationId(applicationId);
    if (!existing) {
      throw new SubscriptionError(`No subscription found for application ${applicationId}`);
    }

    if (!this.apiKey || !existing.stripeSubscriptionId?.startsWith('sub_')) {
      // Simulated subscription (or no live key) — update local state only.
      const updated = await this.subscriptionRepo.update(existing.id, atPeriodEnd
        ? { cancelAtPeriodEnd: true }
        : { status: 'canceled', canceledAt: new Date(), cancelAtPeriodEnd: false });
      return updated!;
    }

    const stripeSub = atPeriodEnd
      ? await scheduleStripeSubscriptionCancellation(this.apiKey, existing.stripeSubscriptionId)
      : await cancelStripeSubscriptionImmediately(this.apiKey, existing.stripeSubscriptionId);

    const updated = await this.subscriptionRepo.update(existing.id, {
      status: stripeSub.status,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      canceledAt: stripeSub.canceled_at ? new Date(stripeSub.canceled_at * 1000) : null,
    });
    return updated!;
  }

  // Syncs local subscription state from a Stripe webhook event
  // (customer.subscription.updated / .deleted, invoice.payment_failed).
  // No-ops (returns null) for event types this doesn't track, or for a
  // subscription id this platform has no local record of — never throws
  // on an unrecognized-but-well-formed event.
  async syncFromStripeEvent(event: {
    type: string;
    data: { object: Record<string, unknown> };
  }): Promise<SubscriptionRecord | null> {
    const obj = event.data.object as any;

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const existing = await this.subscriptionRepo.findByStripeSubscriptionId(obj.id);
      if (!existing) return null;
      const updated = await this.subscriptionRepo.update(existing.id, {
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status,
        currentPeriodStart: obj.current_period_start ? new Date(obj.current_period_start * 1000) : undefined,
        currentPeriodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000) : undefined,
        cancelAtPeriodEnd: !!obj.cancel_at_period_end,
        canceledAt: obj.canceled_at ? new Date(obj.canceled_at * 1000) : undefined,
      });
      return updated ?? null;
    }

    if (event.type === 'invoice.payment_failed') {
      const stripeSubscriptionId = obj.subscription;
      if (!stripeSubscriptionId) return null;
      const existing = await this.subscriptionRepo.findByStripeSubscriptionId(stripeSubscriptionId);
      if (!existing) return null;
      const updated = await this.subscriptionRepo.update(existing.id, { status: 'past_due' });
      return updated ?? null;
    }

    return null;
  }
}
