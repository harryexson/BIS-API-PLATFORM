import { eq } from 'drizzle-orm';
import { getDb } from '../connection';
import { plans, type Plan, type NewPlan } from '../schema';

export const planRepository = {
  async findById(id: string): Promise<Plan | undefined> {
    const db = getDb();
    const rows = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
    return rows[0];
  },

  async findBySlug(slug: string): Promise<Plan | undefined> {
    const db = getDb();
    const rows = await db.select().from(plans).where(eq(plans.slug, slug)).limit(1);
    return rows[0];
  },

  async listActive(): Promise<Plan[]> {
    const db = getDb();
    return db.select().from(plans).where(eq(plans.isActive, true));
  },

  async list(): Promise<Plan[]> {
    const db = getDb();
    return db.select().from(plans);
  },

  async create(data: NewPlan): Promise<Plan> {
    const db = getDb();
    const rows = await db.insert(plans).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewPlan>): Promise<Plan | undefined> {
    const db = getDb();
    const rows = await db
      .update(plans)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(plans.id, id))
      .returning();
    return rows[0];
  },
};
