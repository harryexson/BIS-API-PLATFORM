import { eq, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  providerHealth,
  type ProviderHealthRecord,
  type NewProviderHealthRecord,
} from '../schema';

export const providerHealthRepository = {
  async recordCheck(
    data: NewProviderHealthRecord,
  ): Promise<ProviderHealthRecord> {
    const db = getDb();
    const rows = await db.insert(providerHealth).values(data).returning();
    return rows[0];
  },

  async findLatestByProviderId(
    providerId: string,
  ): Promise<ProviderHealthRecord | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.providerId, providerId))
      .orderBy(desc(providerHealth.checkedAt))
      .limit(1);
    return rows[0];
  },

  async findByProviderId(
    providerId: string,
    limit = 50,
  ): Promise<ProviderHealthRecord[]> {
    const db = getDb();
    return db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.providerId, providerId))
      .orderBy(desc(providerHealth.checkedAt))
      .limit(limit);
  },

  async pruneOlderThan(days: number): Promise<number> {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const rows = await db
      .delete(providerHealth)
      .where(eq(providerHealth.checkedAt, cutoff))
      .returning();
    return rows.length;
  },
};
