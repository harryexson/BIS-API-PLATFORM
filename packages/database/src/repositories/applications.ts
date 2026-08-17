import { eq, desc, and, SQL, count } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  applications,
  type Application,
  type NewApplication,
} from '../schema';

export const applicationRepository = {
  async findById(id: string): Promise<Application | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .limit(1);
    return rows[0];
  },

  async findBySlug(slug: string): Promise<Application | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.slug, slug))
      .limit(1);
    return rows[0];
  },

  async findByName(name: string): Promise<Application | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.name, name))
      .limit(1);
    return rows[0];
  },

  async findAll(): Promise<Application[]> {
    const db = getDb();
    return db.select().from(applications).orderBy(desc(applications.createdAt));
  },

  async create(data: NewApplication): Promise<Application> {
    const db = getDb();
    const rows = await db.insert(applications).values(data).returning();
    return rows[0];
  },

  async update(
    id: string,
    data: Partial<NewApplication>,
  ): Promise<Application | undefined> {
    const db = getDb();
    const rows = await db
      .update(applications)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(applications.id, id))
      .returning();
    return rows[0];
  },

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(applications)
      .where(eq(applications.id, id))
      .returning();
    return rows.length > 0;
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(applications);
    return rows[0]?.value ?? 0;
  },
};
