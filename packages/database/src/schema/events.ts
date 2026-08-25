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

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_events_app_id').on(t.appId),
    index('idx_events_category').on(t.category),
    index('idx_events_provider_id').on(t.providerId),
    index('idx_events_created_at').on(t.createdAt),
  ],
);

export type EventRecord = typeof events.$inferSelect;
export type NewEventRecord = typeof events.$inferInsert;
