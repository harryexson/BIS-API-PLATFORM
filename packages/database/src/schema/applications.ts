import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';

export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    environment: text('environment').notNull().default('development'),
    allowedCapabilities: jsonb('allowed_capabilities'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_applications_name').on(t.name),
    index('idx_applications_slug').on(t.slug),
    index('idx_applications_status').on(t.status),
    index('idx_applications_environment').on(t.environment),
  ],
);

export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
