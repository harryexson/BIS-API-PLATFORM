import { eq, and, desc, count } from 'drizzle-orm';
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

  async count(applicationId: string): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(auditLogs).where(eq(auditLogs.applicationId, applicationId));
    return rows[0]?.value ?? 0;
  },
};
