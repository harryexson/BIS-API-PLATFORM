import { eq, desc, and, count, sql } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  users,
  type User,
  type NewUser,
} from '../schema';

export const userRepository = {
  async findById(id: string): Promise<User | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0];
  },

  async findByApplicationAndEmail(
    applicationId: string,
    email: string,
  ): Promise<User | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(
        eq(users.applicationId, applicationId) &&
          eq(users.email, email),
      )
      .limit(1);
    return rows[0];
  },

  async findByApplicationId(applicationId: string): Promise<User[]> {
    const db = getDb();
    return db
      .select()
      .from(users)
      .where(eq(users.applicationId, applicationId))
      .orderBy(desc(users.createdAt));
  },

  async create(data: NewUser): Promise<User> {
    const db = getDb();
    const rows = await db.insert(users).values(data).returning();
    return rows[0];
  },

  async update(
    id: string,
    data: Partial<NewUser>,
  ): Promise<User | undefined> {
    const db = getDb();
    const rows = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return rows[0];
  },

  async incrementFailedLoginAttempts(id: string): Promise<User | undefined> {
    const db = getDb();
    const rows = await db
      .update(users)
      .set({
        failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    return rows[0];
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(users);
    return rows[0]?.value ?? 0;
  },
};
