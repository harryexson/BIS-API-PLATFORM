import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * P0: Platform-level idempotency records.
 *
 * Scoped by (appId, tenantId, operation, idempotencyKey) to prevent:
 * - Cross-application key collisions
 * - Cross-tenant key collisions
 * - Different operations with the same key returning wrong cached results
 *
 * Provider-specific idempotency (e.g., Stripe's Idempotency-Key header)
 * is an additional internal layer on top of this.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('pending'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_idempotency_composite').on(t.appId, t.tenantId, t.operation, t.idempotencyKey),
  ],
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
