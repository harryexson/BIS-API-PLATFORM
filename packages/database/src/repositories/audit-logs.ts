import { eq, and, desc, count, isNull } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  auditLogs,
  type AuditLog,
  type NewAuditLog,
} from '../schema';

export const auditLogRepository = {
  async create(data: NewAuditLog): Promise<AuditLog> {
    const db = getDb();
    const rows = await db.insert(auditLogs).values(data).returning();
    return rows[0];
  },

  async findByApplicationId(
    applicationId: string,
    limit = 100,
  ): Promise<AuditLog[]> {
    const db = getDb();
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.applicationId, applicationId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  },

  async findByUserId(userId: string, limit = 100): Promise<AuditLog[]> {
    const db = getDb();
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  },

  /**
   * P0: Scoped to application. Never return audit logs across all apps.
   */
  async findByAction(applicationId: string, action: string, limit = 100): Promise<AuditLog[]> {
    const db = getDb();
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.applicationId, applicationId), eq(auditLogs.action, action)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  },

  /**
   * P0: Scoped to application. Never return audit logs globally.
   */
  async findRecent(applicationId: string, limit = 50): Promise<AuditLog[]> {
    const db = getDb();
    return db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.applicationId, applicationId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  },

  /**
   * Phase 20-21 (gap register C7): marks an in-flight admin action's row
   * (written with outcome 'started' before the action ran) with its final
   * outcome. One single-statement UPDATE, scoped to platform-level admin
   * rows so it can never rewrite an application's audit trail.
   */
  async completeAdminAction(
    id: string,
    result: { outcome: string; statusCode: number | null; action?: string; details?: string | null },
  ): Promise<AuditLog | undefined> {
    const db = getDb();
    const rows = await db
      .update(auditLogs)
      .set({
        ...(result.action !== undefined ? { action: result.action } : {}),
        outcome: result.outcome,
        statusCode: result.statusCode,
        ...(result.details !== undefined ? { details: result.details } : {}),
      })
      .where(and(eq(auditLogs.id, id), eq(auditLogs.actorType, 'admin'), isNull(auditLogs.applicationId)))
      .returning();
    return rows[0];
  },

  /**
   * Phase 20-21: the platform-level admin audit trail (actor_type 'admin',
   * application_id NULL), newest first. Never returns any application's
   * own audit rows.
   */
  async listAdminActions(opts: { actorId?: string; action?: string; limit?: number } = {}): Promise<AuditLog[]> {
    const db = getDb();
    const conditions = [eq(auditLogs.actorType, 'admin'), isNull(auditLogs.applicationId)];
    if (opts.actorId) conditions.push(eq(auditLogs.actorId, opts.actorId));
    if (opts.action) conditions.push(eq(auditLogs.action, opts.action));
    return db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  },

  async count(applicationId: string): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(auditLogs).where(eq(auditLogs.applicationId, applicationId));
    return rows[0]?.value ?? 0;
  },
};
