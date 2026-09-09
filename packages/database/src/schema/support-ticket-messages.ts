import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { supportTickets } from './support-tickets';

export const supportTicketMessages = pgTable(
  'support_ticket_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    authorType: text('author_type').notNull(),
    authorEmail: text('author_email'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_support_ticket_messages_ticket_id').on(t.ticketId)],
);

export type SupportTicketMessage = typeof supportTicketMessages.$inferSelect;
export type NewSupportTicketMessage = typeof supportTicketMessages.$inferInsert;
