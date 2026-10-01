import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { applications } from './applications';

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull().default('open'), // open | in_progress | resolved | closed
    priority: text('priority').notNull().default('normal'), // low | normal | high | urgent
    requesterEmail: text('requester_email'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_support_tickets_application_id').on(t.applicationId),
    index('idx_support_tickets_status').on(t.status),
  ],
);

export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
