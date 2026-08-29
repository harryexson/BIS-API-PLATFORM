import { pgTable, uuid, text, timestamp, jsonb, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * P0: Transactions table — the payment state machine.
 *
 * Tracks the lifecycle of a payment: pending → success/failed/refunded.
 * Webhooks update the status based on provider events.
 * The idempotency_key unique index prevents duplicate charges.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    providerId: text('provider_id').notNull(),
    providerTransactionId: text('provider_transaction_id'),
    status: text('status').notNull().default('pending'),
    amount: numeric('amount').notNull(),
    currency: text('currency').notNull(),
    paymentMethod: text('payment_method'),
    idempotencyKey: text('idempotency_key'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_transactions_app_id').on(t.appId),
    index('idx_transactions_tenant_id').on(t.tenantId),
    index('idx_transactions_provider_tx_id').on(t.providerTransactionId),
    index('idx_transactions_status').on(t.status),
    uniqueIndex('idx_transactions_idempotency').on(t.appId, t.tenantId, t.idempotencyKey),
  ],
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
