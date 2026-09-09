import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { roles, type Role, type NewRole } from '../schema';

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
};
