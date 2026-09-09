import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { subscriptionPlans } from './subscription-plans';

/**
 * Per-tenant subscription/billing state. appId/tenantId are the loose text
 * identifiers used across the traffic-facing tables (transactions,
 * conversations, idempotency_records) rather than uuid FKs, so this joins
 * cleanly with gateway-resolved request context.
 *
 * `status` mirrors common billing-provider vocabulary (trialing/active/
 * past_due/canceled) so it can be driven by real Stripe webhooks once that
 * connection is authorized; until then it is the platform's own record.
 */
export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('trialing'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull().defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: timestamp('cancel_at_period_end', { withTimezone: true }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_tenant_subscriptions_app_id').on(t.appId),
    index('idx_tenant_subscriptions_status').on(t.status),
    uniqueIndex('idx_tenant_subscriptions_app_tenant').on(t.appId, t.tenantId),
  ],
);

export type TenantSubscription = typeof tenantSubscriptions.$inferSelect;
export type NewTenantSubscription = typeof tenantSubscriptions.$inferInsert;
