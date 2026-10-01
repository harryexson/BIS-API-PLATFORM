import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { roles, permissions, type Role, type NewRole, type Permission, type NewPermission } from '../schema';
import { permissionRepository } from './permissions';

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
    return db
      .select()
      .from(roles)
      .where(eq(roles.applicationId, applicationId))
      .orderBy(desc(roles.createdAt));
  },

  async create(data: NewRole): Promise<Role> {
    const db = getDb();
    const rows = await db.insert(roles).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewRole>): Promise<Role | undefined> {
    const db = getDb();
    const rows = await db
      .update(roles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(roles.id, id))
      .returning();
    return rows[0];
  },

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const rows = await db.delete(roles).where(eq(roles.id, id)).returning();
    return rows.length > 0;
  },

  // Thin wrapper so AuthRegistry's RoleRepositoryForAuth interface can be
  // satisfied without a second code path for granting a permission —
  // permissionRepository.grant() already does this idempotently.
  async addPermission(data: NewPermission): Promise<Permission> {
    return permissionRepository.grant(data);
  },

  async findPermissionsByRoleId(roleId: string): Promise<Permission[]> {
    const db = getDb();
    return db.select().from(permissions).where(eq(permissions.roleId, roleId));
  },
};
