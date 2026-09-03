import { pgTable, uuid, text, numeric, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * A checkout session lets a business create a hosted, single-use payment
 * link server-side (using their real API key) and hand the customer's
 * browser only an opaque public token — the browser never sees the
 * application's secret API key. See services/api-gateway/src/checkout.ts.
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    amount: numeric('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('pending'),
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    paymentEventId: text('payment_event_id'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_checkout_sessions_token').on(t.token),
    index('idx_checkout_sessions_app_id').on(t.appId),
    index('idx_checkout_sessions_status').on(t.status),
  ],
);

export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert;
