import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  integer,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { tenants } from './tenants';
import { roles } from './roles';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    // A user's role within their application (owner/admin/member — see
    // roles.ts). Nullable so existing rows and system/service users are
    // unaffected; a real signup always sets this.
    roleId: uuid('role_id').references(() => roles.id, {
      onDelete: 'set null',
    }),
    email: text('email').notNull(),
    name: text('name'),
    passwordHash: text('password_hash'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntilAt: timestamp('locked_until_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_users_application_id').on(t.applicationId),
    index('idx_users_tenant_id').on(t.tenantId),
    index('idx_users_role_id').on(t.roleId),
    uniqueIndex('idx_users_application_email').on(t.applicationId, t.email),
    // Signup/login are global (email + password, no application context
    // required from the caller) — the platform's own account model is
    // "one signup creates one application", so email is enforced globally
    // unique, not just per-application. This table had zero rows/usage
    // before this migration (confirmed by audit), so tightening it here is
    // safe.
    uniqueIndex('idx_users_email').on(t.email),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
