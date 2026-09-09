import { eq, and } from 'drizzle-orm';
import { getDb } from '../connection';
import { tenantSubscriptions, type TenantSubscription, type NewTenantSubscription } from '../schema';

const ACTIVE_STATUSES = new Set(['trialing', 'active', 'past_due']);

export const tenantSubscriptionRepository = {
  async findByAppAndTenant(appId: string, tenantId: string): Promise<TenantSubscription | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(tenantSubscriptions)
      .where(and(eq(tenantSubscriptions.appId, appId), eq(tenantSubscriptions.tenantId, tenantId)))
      .limit(1);
    return rows[0];
  },

  async isEntitled(appId: string, tenantId: string): Promise<boolean> {
    const sub = await this.findByAppAndTenant(appId, tenantId);
    return !!sub && ACTIVE_STATUSES.has(sub.status);
  },

  async listByAppId(appId: string): Promise<TenantSubscription[]> {
    const db = getDb();
    return db.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.appId, appId));
  },

  async create(data: NewTenantSubscription): Promise<TenantSubscription> {
    const db = getDb();
    const rows = await db.insert(tenantSubscriptions).values(data).returning();
    return rows[0];
  },

  async updateStatus(
    appId: string,
    tenantId: string,
    status: string,
    periodFields?: Partial<Pick<NewTenantSubscription, 'currentPeriodStart' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'>>,
  ): Promise<TenantSubscription | undefined> {
    const db = getDb();
    const rows = await db
      .update(tenantSubscriptions)
      .set({ status, ...periodFields, updatedAt: new Date() })
      .where(and(eq(tenantSubscriptions.appId, appId), eq(tenantSubscriptions.tenantId, tenantId)))
      .returning();
    return rows[0];
  },

  async changePlan(appId: string, tenantId: string, planId: string): Promise<TenantSubscription | undefined> {
    const db = getDb();
    const rows = await db
      .update(tenantSubscriptions)
      .set({ planId, updatedAt: new Date() })
      .where(and(eq(tenantSubscriptions.appId, appId), eq(tenantSubscriptions.tenantId, tenantId)))
      .returning();
    return rows[0];
  },
};
