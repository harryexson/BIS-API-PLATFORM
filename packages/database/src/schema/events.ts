import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';

// P0: appId here is the application's slug (e.g. 'reach-church'), not its
// UUID primary key — every caller resolves it that way (see
// services/api-gateway/src/auth.ts's authenticateApplication(), which sets
// appId = application.slug). The FK below references applications.slug
// (a unique column) for exactly that reason, not applications.id.
// Two sentinel rows — 'system' (provider-level events with no owning
// tenant app: provider_webhook processing, the reconciliation job) and
// 'webhook' (a payment webhook whose payload carried no
// metadata.appId) — are seeded as real applications rows by the migration
// that adds this constraint, rather than special-cased in application
// code, so every events.app_id value is a real, valid reference.
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull().references(() => applications.slug),
    tenantId: text('tenant_id').default('default'),
    category: text('category').notNull(),
    providerId: text('provider_id'),
    status: text('status').notNull(),
    amount: numeric('amount'),
    currency: text('currency'),
    latency: integer('latency'),
    cost: numeric('cost'),
    decisionReason: text('decision_reason'),
    payload: jsonb('payload'),
    response: jsonb('response'),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_events_app_id').on(t.appId),
    index('idx_events_tenant_id').on(t.tenantId),
    index('idx_events_category').on(t.category),
    index('idx_events_provider_id').on(t.providerId),
    index('idx_events_created_at').on(t.createdAt),
  ],
);

export type EventRecord = typeof events.$inferSelect;
export type NewEventRecord = typeof events.$inferInsert;
