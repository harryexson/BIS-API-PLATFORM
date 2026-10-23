import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { users } from './users';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = a platform-level entry (today the only writer is the
    // reconciliation job, resource 'system'). Phase 16 (gap register D16):
    // ON DELETE RESTRICT, not SET NULL — hard-deleting an application used
    // to silently strip the attribution from its whole audit trail. No code
    // path deletes applications (applicationRepository.delete has no
    // callers; events.app_id already blocks it for any app with events), so
    // retire an application by status, never by DELETE.
    applicationId: uuid('application_id').references(
      () => applications.id,
      { onDelete: 'restrict' },
    ),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    resourceId: text('resource_id'),
    details: text('details'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // Phase 20-21 (gap register C7): WHO performed the action when the
    // actor is not an application user (user_id) — today, a BIS platform
    // administrator identified by their own named admin credential
    // (actor_type 'admin', actor_id = the credential's id from
    // ADMIN_API_CREDENTIALS). Previously every admin action was performed
    // with one shared token and nothing recorded who did what.
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    // Outcome of the audited action: 'started' while it is in flight (the
    // row is written BEFORE an admin mutation runs), then 'success' /
    // 'client_error' / 'server_error' / 'stream_closed' / 'aborted' /
    // 'denied', with the HTTP status_code.
    outcome: text('outcome'),
    statusCode: integer('status_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_audit_logs_application_id').on(t.applicationId),
    index('idx_audit_logs_user_id').on(t.userId),
    index('idx_audit_logs_action').on(t.action),
    index('idx_audit_logs_resource').on(t.resource),
    index('idx_audit_logs_created_at').on(t.createdAt),
    index('idx_audit_logs_actor').on(t.actorType, t.actorId, t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
