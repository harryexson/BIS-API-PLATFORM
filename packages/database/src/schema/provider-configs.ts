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

export const providerConfigs = pgTable(
  'provider_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull().default('test'),
    encryptedSecret: text('encrypted_secret'),
    secretIv: text('secret_iv'),
    secretTag: text('secret_tag'),
    publishableKey: text('publishable_key'),
    webhookSecret: text('webhook_secret'),
    additionalConfig: text('additional_config'),
    weight: integer('weight').notNull().default(50),
    latencyMin: integer('latency_min').notNull().default(100),
    latencyMax: integer('latency_max').notNull().default(200),
    enabled: text('enabled').notNull().default('true'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_provider_configs_provider_id').on(t.providerId),
    uniqueIndex('idx_provider_configs_provider_env').on(
      t.providerId,
      t.environment,
    ),
  ],
);

export type ProviderConfig = typeof providerConfigs.$inferSelect;
export type NewProviderConfig = typeof providerConfigs.$inferInsert;
