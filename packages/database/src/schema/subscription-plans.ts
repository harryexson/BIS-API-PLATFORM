import { pgTable, uuid, text, integer, jsonb, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Platform-wide subscription plan catalog (pricing management). This is the
 * internal source of truth for plan definitions; `stripeProductId`/
 * `stripePriceId` are nullable sync targets for a future Stripe connection —
 * no billing provider is called from this table alone.
 */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    billingInterval: text('billing_interval').notNull().default('month'),
    features: jsonb('features'),
    isActive: boolean('is_active').notNull().default(true),
    stripeProductId: text('stripe_product_id'),
    stripePriceId: text('stripe_price_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_subscription_plans_active').on(t.isActive),
    uniqueIndex('idx_subscription_plans_slug').on(t.slug),
  ],
);

export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
