import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { applications } from './applications';

/**
 * P0: Suppliers table — explicit ownership boundary for multi-supplier applications.
 *
 * Before connecting Afribook/STAYSCAPE, the schema needs an explicit ownership chain:
 *   Application → Tenant → Supplier → Resource
 *
 * Every sensitive operation must verify the applicable ownership chain.
 */
export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    type: text('type').notNull(), // 'hotel', 'church', 'organization'
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_suppliers_application_id').on(t.applicationId),
    uniqueIndex('idx_suppliers_application_slug').on(t.applicationId, t.tenantId, t.slug),
  ],
);

export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
