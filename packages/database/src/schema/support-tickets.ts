import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Thin in-house support ticket record. This is intentionally minimal — the
 * long-term plan is to integrate an existing helpdesk (Zendesk/Intercom/
 * HubSpot); `externalProvider`/`externalRef` are nullable sync fields for
 * that integration. Until a provider is connected, this table is the only
 * record of a ticket.
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    requesterEmail: text('requester_email').notNull(),
    subject: text('subject').notNull(),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    externalProvider: text('external_provider'),
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_support_tickets_app_id').on(t.appId),
    index('idx_support_tickets_tenant_id').on(t.tenantId),
    index('idx_support_tickets_status').on(t.status),
  ],
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
