import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  integer,
  jsonb,
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
    // Phase 15 (gap register E12): the admin-controlled provider
    // configuration (status, weight/priority, environment, countries,
    // currencies, capabilities, fees, routing rules) — previously held only
    // in each process's in-memory ProviderRegistry. One JSON document per
    // (provider, deployment tier), the same key the encrypted secrets use.
    managementConfig: jsonb('management_config').$type<Record<string, unknown>>(),
    // Compare-and-set versions, bumped on every write of the respective
    // half of this row (see provider-state.ts). Replicas apply a row only
    // when its version is newer than the one they hold; 0 = never written.
    managementVersion: integer('management_version').notNull().default(0),
    secretsVersion: integer('secrets_version').notNull().default(0),
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
