import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';

export const applicationPermissions = pgTable(
  'application_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_app_perms_application_id').on(t.applicationId),
    uniqueIndex('idx_app_perms_application_resource_action').on(
      t.applicationId,
      t.resource,
      t.action,
    ),
  ],
);

export type ApplicationPermission = typeof applicationPermissions.$inferSelect;
export type NewApplicationPermission =
  typeof applicationPermissions.$inferInsert;
