import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * P0: Transactional outbox table.
 *
 * When a webhook processor writes an event record and needs to emit to EventBus,
 * it writes both atomically in a transaction. The outbox poller worker picks up
 * pending events and emits them, ensuring at-least-once delivery.
 *
 * This closes the gap between "event written to DB" and "event emitted to bus".
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    index('idx_outbox_status').on(t.status),
    index('idx_outbox_created_at').on(t.createdAt),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
