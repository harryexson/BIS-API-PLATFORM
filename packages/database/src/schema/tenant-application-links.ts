import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { tenants } from './tenants';

export const tenantApplicationLinks = pgTable(
  'tenant_application_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_tenant_app_links_tenant_id').on(t.tenantId),
    index('idx_tenant_app_links_application_id').on(t.applicationId),
    uniqueIndex('idx_tenant_app_links_tenant_app').on(
      t.tenantId,
      t.applicationId,
    ),
  ],
);

export type TenantApplicationLink =
  typeof tenantApplicationLinks.$inferSelect;
export type NewTenantApplicationLink =
  typeof tenantApplicationLinks.$inferInsert;
