import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, numeric, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { tenantIdNonBlank } from './tenant-id-check';

/**
 * P0: Transactions table — the payment state machine.
 *
 * The full state/transition graph is documented (and defined) in
 * ../transaction-status.ts; chk_transactions_status (migration 0016) makes
 * Postgres reject any status outside it. Transitions are applied by single
 * conditional UPDATE statements (repositories/transactions.ts
 * transitionStatus, repositories/webhook-events.ts persistEffectsOnce).
 * The idempotency_key unique index prevents duplicate charges.
 *
 * Reconciliation bookkeeping (migration 0016, Phase 6 — gap register D4):
 *   outcome_unknown_at          first time the row entered an ambiguous state
 *                               ('unknown' / 'requires_reconciliation'); never
 *                               cleared — a row that was ever ambiguous can
 *                               never be re-opened for another charge attempt.
 *   reconciliation_reason       why it is (or was) ambiguous / escalated.
 *   reconciliation_required_at  when it was escalated to the operator list.
 *   reconciliation_checked_at / reconciliation_check_count /
 *   reconciliation_last_check   the reconciliation job's read-only provider
 *                               status checks (never a charge) and the last
 *                               one's result.
 *   reconciliation_resolved_at / reconciliation_resolution
 *                               when and how (provider webhook / provider
 *                               status check / operator) an ambiguous outcome
 *                               was resolved.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull(),
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
    outcomeUnknownAt: timestamp('outcome_unknown_at', { withTimezone: true }),
    reconciliationReason: text('reconciliation_reason'),
    reconciliationRequiredAt: timestamp('reconciliation_required_at', { withTimezone: true }),
    reconciliationCheckedAt: timestamp('reconciliation_checked_at', { withTimezone: true }),
    reconciliationCheckCount: integer('reconciliation_check_count').notNull().default(0),
    reconciliationLastCheck: jsonb('reconciliation_last_check'),
    reconciliationResolvedAt: timestamp('reconciliation_resolved_at', { withTimezone: true }),
    reconciliationResolution: jsonb('reconciliation_resolution'),
  },
  (t) => [
    index('idx_transactions_app_id').on(t.appId),
    index('idx_transactions_tenant_id').on(t.tenantId),
    index('idx_transactions_provider_tx_id').on(t.providerTransactionId),
    index('idx_transactions_status').on(t.status),
    uniqueIndex('idx_transactions_idempotency').on(t.appId, t.tenantId, t.idempotencyKey),
    // The reconciliation sweep's working set: unresolved rows by age.
    index('idx_transactions_unresolved')
      .on(t.updatedAt)
      .where(sql`${t.status} IN ('processing', 'pending', 'requires_action', 'unknown', 'requires_reconciliation')`),
    check(
      'chk_transactions_status',
      sql`${t.status} IN ('processing', 'pending', 'requires_action', 'success', 'failed', 'cancelled', 'partially_refunded', 'refunded', 'unknown', 'requires_reconciliation')`,
    ),
    tenantIdNonBlank('transactions', t.tenantId),
  ],
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
