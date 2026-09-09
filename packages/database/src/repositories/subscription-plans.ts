import { eq } from 'drizzle-orm';
import { getDb } from '../connection';
import { subscriptionPlans, type SubscriptionPlan, type NewSubscriptionPlan } from '../schema';

export const subscriptionPlanRepository = {
  async findById(id: string): Promise<SubscriptionPlan | undefined> {
    const db = getDb();
    const rows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
    return rows[0];
  },

  async findBySlug(slug: string): Promise<SubscriptionPlan | undefined> {
    const db = getDb();
    const rows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.slug, slug)).limit(1);
    return rows[0];
  },

  async listActive(): Promise<SubscriptionPlan[]> {
    const db = getDb();
    return db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, true));
  },

  async listAll(): Promise<SubscriptionPlan[]> {
    const db = getDb();
    return db.select().from(subscriptionPlans);
  },

  async create(data: NewSubscriptionPlan): Promise<SubscriptionPlan> {
    const db = getDb();
    const rows = await db.insert(subscriptionPlans).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewSubscriptionPlan>): Promise<SubscriptionPlan | undefined> {
    const db = getDb();
    const rows = await db
      .update(subscriptionPlans)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, id))
      .returning();
    return rows[0];
  },

  async deactivate(id: string): Promise<SubscriptionPlan | undefined> {
    return this.update(id, { isActive: false });
  },
};
