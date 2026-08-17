import { eq, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  providerConfigs,
  type ProviderConfig,
  type NewProviderConfig,
} from '../schema';

export const providerConfigRepository = {
  async findById(id: string): Promise<ProviderConfig | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .limit(1);
    return rows[0];
  },

  async findByProviderAndEnvironment(
    providerId: string,
    environment: string,
  ): Promise<ProviderConfig | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(providerConfigs)
      .where(
        eq(providerConfigs.providerId, providerId) &&
          eq(providerConfigs.environment, environment),
      )
      .limit(1);
    return rows[0];
  },

  async findByProviderId(providerId: string): Promise<ProviderConfig[]> {
    const db = getDb();
    return db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.providerId, providerId))
      .orderBy(desc(providerConfigs.createdAt));
  },

  async create(data: NewProviderConfig): Promise<ProviderConfig> {
    const db = getDb();
    const rows = await db.insert(providerConfigs).values(data).returning();
    return rows[0];
  },

  async update(
    id: string,
    data: Partial<NewProviderConfig>,
  ): Promise<ProviderConfig | undefined> {
    const db = getDb();
    const rows = await db
      .update(providerConfigs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(providerConfigs.id, id))
      .returning();
    return rows[0];
  },

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(providerConfigs)
      .where(eq(providerConfigs.id, id))
      .returning();
    return rows.length > 0;
  },
};
