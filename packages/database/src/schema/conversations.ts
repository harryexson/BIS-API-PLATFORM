import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phoneNumber: text('phone_number').notNull(),
    appId: text('app_id').notNull(),
    // P0 FIX: tenantId is now required for multi-tenant conversation isolation.
    // Within the same appId, different tenants must not share conversation state.
    // Apps that don't use tenants should pass 'default' as tenantId.
    tenantId: text('tenant_id').notNull().default('default'),
    providerId: text('provider_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('active'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_conversations_phone').on(t.phoneNumber),
    index('idx_conversations_app').on(t.appId),
    index('idx_conversations_tenant').on(t.tenantId),
    index('idx_conversations_provider').on(t.providerId),
    index('idx_conversations_status').on(t.status),
    // P0 FIX: Unique index now includes tenantId — prevents cross-tenant
    // conversation bleed within the same application.
    uniqueIndex('idx_conversations_phone_app_tenant').on(
      t.phoneNumber,
      t.appId,
      t.tenantId,
    ),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
