import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
} from 'drizzle-orm/pg-core';
import { providers } from './providers';

export const providerHealth = pgTable(
  'provider_health',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    checkType: text('check_type').notNull(),
    status: text('status').notNull(),
    latencyMs: integer('latency_ms'),
    errorMessage: text('error_message'),
    checkedAt: timestamp('checked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_provider_health_provider_id').on(t.providerId),
    index('idx_provider_health_provider_checked').on(
      t.providerId,
      t.checkedAt,
    ),
  ],
);

export type ProviderHealthRecord = typeof providerHealth.$inferSelect;
export type NewProviderHealthRecord = typeof providerHealth.$inferInsert;
