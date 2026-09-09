import { eq } from 'drizzle-orm';
import { getDb } from '../connection';
import { subscriptions, type Subscription, type NewSubscription } from '../schema';

export const subscriptionRepository = {
  async findById(id: string): Promise<Subscription | undefined> {
    const db = getDb();
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    return rows[0];
  },

  async findByApplicationId(applicationId: string): Promise<Subscription | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.applicationId, applicationId))
      .limit(1);
    return rows[0];
  },

  async findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<Subscription | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
      .limit(1);
    return rows[0];
  },

  async create(data: NewSubscription): Promise<Subscription> {
    const db = getDb();
    const rows = await db.insert(subscriptions).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewSubscription>): Promise<Subscription | undefined> {
    const db = getDb();
    const rows = await db
      .update(subscriptions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
      .returning();
    return rows[0];
  },
};
