import { eq, and } from 'drizzle-orm';
import { getDb } from '../connection';
import { permissions, type Permission, type NewPermission } from '../schema';

export const permissionRepository = {
  async findByRoleId(roleId: string): Promise<Permission[]> {
    const db = getDb();
    return db.select().from(permissions).where(eq(permissions.roleId, roleId));
  },

  async grant(data: NewPermission): Promise<Permission> {
    const db = getDb();
    const rows = await db
      .insert(permissions)
      .values(data)
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];
    const existing = await db
      .select()
      .from(permissions)
      .where(
        and(
          eq(permissions.roleId, data.roleId),
          eq(permissions.resource, data.resource),
          eq(permissions.action, data.action),
        ),
      )
      .limit(1);
    return existing[0];
  },

  async revoke(roleId: string, resource: string, action: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(permissions)
      .where(
        and(
          eq(permissions.roleId, roleId),
          eq(permissions.resource, resource),
          eq(permissions.action, action),
        ),
      )
      .returning();
    return rows.length > 0;
  },

  async revokeAllForRole(roleId: string): Promise<number> {
    const db = getDb();
    const rows = await db.delete(permissions).where(eq(permissions.roleId, roleId)).returning();
    return rows.length;
  },
};
