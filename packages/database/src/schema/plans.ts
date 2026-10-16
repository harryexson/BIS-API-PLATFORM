import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Subscription plan tiers for the BIS Platform's own customers (the
// businesses that hold an application — Reach Church, HaulPro, etc.),
// billed for platform usage. Distinct from `transactions`, which models
// one-off payments the platform routes on a customer's behalf.
//
// Seed plans inserted by this table's migration are placeholder pricing —
// a mechanism for real subscription billing, not a business decision
// about actual prices. Whoever owns pricing should update these rows
// (or add new ones) before this is used for real billing.
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    interval: text('interval').notNull().default('month'), // 'month' | 'year'
    // Soft usage limits — informational only in this pass; nothing in the
    // gateway enforces them yet (see IMPLEMENTATION_BASELINE.md).
    messageLimit: integer('message_limit'), // null = unlimited
    paymentVolumeLimitCents: integer('payment_volume_limit_cents'), // null = unlimited
    // Populated once a matching Stripe Price is created in live mode.
    // Null means this plan has no live-mode counterpart yet (only
    // simulated subscriptions are possible against it).
    stripePriceId: text('stripe_price_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('idx_plans_slug').on(t.slug),
    index('idx_plans_is_active').on(t.isActive),
  ],
);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
