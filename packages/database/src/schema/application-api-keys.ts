import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';

export const applicationApiKeys = pgTable(
  'application_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    environment: text('environment').notNull().default('test'),
    scopes: text('scopes'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_api_keys_application_id').on(t.applicationId),
    index('idx_api_keys_prefix').on(t.prefix),
    uniqueIndex('idx_api_keys_hash').on(t.keyHash),
  ],
);

export type ApplicationApiKey = typeof applicationApiKeys.$inferSelect;
export type NewApplicationApiKey = typeof applicationApiKeys.$inferInsert;
