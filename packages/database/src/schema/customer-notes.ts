import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { applications } from './applications';

// Free-text notes BIS staff attach to a customer (application) — CRM
// context, not visible to the customer themselves. `authorName` is a
// plain string rather than a user FK: admin auth is a single shared
// token (see requireAdmin in services/api-gateway/src/app.ts), so there
// is no per-admin identity to reference yet.
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_customer_notes_application_id').on(t.applicationId)],
);

export type CustomerNote = typeof customerNotes.$inferSelect;
export type NewCustomerNote = typeof customerNotes.$inferInsert;
