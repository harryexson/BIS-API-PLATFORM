import { eq, desc, lt } from 'drizzle-orm';
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

  /**
   * Deletes every health check recorded strictly before `days` days ago and
   * returns how many were removed. Phase 16 (gap register D16): this used
   * `eq(checkedAt, cutoff)` — a row matched only if its timestamp equalled
   * the computed cutoff to the microsecond, so in practice nothing was ever
   * pruned and provider_health grew without bound.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const rows = await db
      .delete(providerHealth)
      .where(lt(providerHealth.checkedAt, cutoff))
      .returning({ id: providerHealth.id });
    return rows.length;
  },
};
