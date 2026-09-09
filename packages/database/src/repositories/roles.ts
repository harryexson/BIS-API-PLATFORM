import { eq, and } from 'drizzle-orm';
import { getDb } from '../connection';
import { roles, permissions, type Role, type NewRole, type Permission, type NewPermission } from '../schema';

export const roleRepository = {
  async findById(id: string): Promise<Role | undefined> {
    const db = getDb();
    const rows = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return rows[0];
  },

  async findByApplicationAndName(applicationId: string, name: string): Promise<Role | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(roles)
      .where(and(eq(roles.applicationId, applicationId), eq(roles.name, name)))
      .limit(1);
    return rows[0];
  },

  async findByApplicationId(applicationId: string): Promise<Role[]> {
    const db = getDb();
    return db.select().from(roles).where(eq(roles.applicationId, applicationId));
  },

  async create(data: NewRole): Promise<Role> {
    const db = getDb();
    const rows = await db.insert(roles).values(data).returning();
    return rows[0];
  },

  async addPermission(data: NewPermission): Promise<Permission> {
    const db = getDb();
    const rows = await db.insert(permissions).values(data).returning();
    return rows[0];
  },

  async findPermissionsByRoleId(roleId: string): Promise<Permission[]> {
    const db = getDb();
    return db.select().from(permissions).where(eq(permissions.roleId, roleId));
  },
};
