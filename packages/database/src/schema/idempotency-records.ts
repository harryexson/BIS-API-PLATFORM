import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenantIdNonBlank } from './tenant-id-check';

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
 *
 * `request_hash` (migration 0013) is a SHA-256 fingerprint of the mutating
 * request fields, stored at CLAIM time. It is deliberately NOT part of the
 * unique index: the unique index must stay on
 * (app_id, tenant_id, operation, idempotency_key) so that two different
 * request bodies under the same key can never both win a claim. Instead the
 * claim path (`idempotencyRecordRepository.claim`, a single atomic
 * INSERT ... ON CONFLICT DO UPDATE ... WHERE statement) compares the stored
 * hash to the incoming one and the caller rejects a mismatch with 409
 * `idempotency_conflict`.
 *
 * NOT NULL DEFAULT '' so the column can be added to a live table without a
 * rewrite/backfill. '' means "legacy row claimed before request hashes
 * existed — hash unknown"; every row claimed by the current code stores a
 * non-empty 64-char hex digest. Legacy rows age out within one TTL window.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull().default(''),
    status: text('status').notNull().default('pending'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idx_idempotency_composite').on(t.appId, t.tenantId, t.operation, t.idempotencyKey),
    tenantIdNonBlank('idempotency_records', t.tenantId),
  ],
);

export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
