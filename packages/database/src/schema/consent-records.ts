import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { tenantIdNonBlank } from './tenant-id-check';

/**
 * Master plan Phase 39 (STOP/START/HELP consent management). Tracks the
 * current opt-in/opt-out status per (application, tenant, recipient,
 * channel) so outbound sends can be checked before dispatch — a STOP
 * keyword closing a conversation isn't durable consent state on its own,
 * and a later conversation for the same recipient must still honor it.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    // Matches the loose text tenantId convention used by conversations.
    // Phase 16: no DB default — every writer passes the verified tenant
    // explicitly; an omitted tenant is a NOT NULL error, never 'default'.
    tenantId: text('tenant_id').notNull(),
    recipient: text('recipient').notNull(), // phone number or email
    channel: text('channel').notNull(), // 'sms' | 'whatsapp' | 'email' | 'voice' | ...
    status: text('status').notNull(), // 'opted_in' | 'opted_out' | 'unknown'
    source: text('source').notNull(), // 'keyword' | 'api' | 'import'
    keyword: text('keyword'), // the inbound keyword that triggered this, if any
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_consent_app').on(t.appId),
    index('idx_consent_tenant').on(t.tenantId),
    index('idx_consent_recipient').on(t.recipient),
    uniqueIndex('idx_consent_recipient_app_tenant_channel').on(
      t.recipient,
      t.appId,
      t.tenantId,
      t.channel,
    ),
    tenantIdNonBlank('consent_records', t.tenantId),
  ],
);

export type ConsentRecord = typeof consentRecords.$inferSelect;
export type NewConsentRecord = typeof consentRecords.$inferInsert;
