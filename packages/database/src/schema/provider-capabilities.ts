import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  integer,
} from 'drizzle-orm/pg-core';
import { providers } from './providers';

export const providerCapabilities = pgTable(
  'provider_capabilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
    currencies: text('currencies'),
    paymentMethods: text('payment_methods'),
    countries: text('countries'),
    maxAmount: text('max_amount'),
    minAmount: text('min_amount'),
    feePercent: text('fee_percent'),
    feeFlat: text('fee_flat'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_provider_capabilities_provider_id').on(t.providerId),
    uniqueIndex('idx_provider_capabilities_provider_capability').on(
      t.providerId,
      t.capability,
    ),
  ],
);

export type ProviderCapability = typeof providerCapabilities.$inferSelect;
export type NewProviderCapability = typeof providerCapabilities.$inferInsert;
