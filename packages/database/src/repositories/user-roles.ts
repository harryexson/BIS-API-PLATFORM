import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../connection';
import { userRoles, roles, permissions, type UserRole } from '../schema';

export const userRoleRepository = {
  async assign(userId: string, roleId: string): Promise<UserRole> {
    const db = getDb();
    const rows = await db
      .insert(userRoles)
      .values({ userId, roleId })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];
    const existing = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
      .limit(1);
    return existing[0];
  },

  async unassign(userId: string, roleId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
      .returning();
    return rows.length > 0;
  },

  async findRoleIdsForUser(userId: string): Promise<string[]> {
    const db = getDb();
    const rows = await db.select().from(userRoles).where(eq(userRoles.userId, userId));
    return rows.map((r) => r.roleId);
  },

  /**
   * Resolves the effective (resource, action) permission set for a user by
   * joining user_roles -> roles -> permissions, scoped to a single
   * application so a role from one application can never grant permissions
   * to a user being checked against another application's resources.
   */
  async findEffectivePermissions(
    userId: string,
    applicationId: string,
  ): Promise<Array<{ resource: string; action: string }>> {
    const db = getDb();
    const roleIds = await db
      .select({ id: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(and(eq(userRoles.userId, userId), eq(roles.applicationId, applicationId)));

    if (roleIds.length === 0) return [];

    const rows = await db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(permissions)
      .where(inArray(permissions.roleId, roleIds.map((r) => r.id)));

    return rows;
  },

  async userHasPermission(userId: string, applicationId: string, resource: string, action: string): Promise<boolean> {
    const grants = await this.findEffectivePermissions(userId, applicationId);
    return grants.some((g) => g.resource === resource && g.action === action);
  },
};
