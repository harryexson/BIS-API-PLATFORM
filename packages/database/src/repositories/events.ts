import { desc, eq, and, count, sql } from 'drizzle-orm';
import { getDb } from '../connection';
import { events, type EventRecord, type NewEventRecord } from '../schema';

export const eventRepository = {
  async create(data: NewEventRecord): Promise<EventRecord> {
    const db = getDb();
    const rows = await db.insert(events).values(data).returning();
    return rows[0];
  },

  /**
   * P0: Scoped to application. Never return events across all apps.
   */
  async findLatest(appId: string, limit = 100): Promise<EventRecord[]> {
    const db = getDb();
    return db
      .select()
      .from(events)
      .where(eq(events.appId, appId))
      .orderBy(desc(events.createdAt))
      .limit(limit);
  },

  async findByAppId(appId: string, limit = 100): Promise<EventRecord[]> {
    const db = getDb();
    return db
      .select()
      .from(events)
      .where(eq(events.appId, appId))
      .orderBy(desc(events.createdAt))
      .limit(limit);
  },

  async findByAppAndTenant(appId: string, tenantId: string, limit = 100): Promise<EventRecord[]> {
    const db = getDb();
    return db
      .select()
      .from(events)
      .where(and(eq(events.appId, appId), eq(events.tenantId, tenantId)))
      .orderBy(desc(events.createdAt))
      .limit(limit);
  },

  /**
   * P0: Scoped to application. Never return cross-app aggregations.
   */
  async countByCategory(appId: string): Promise<Record<string, number>> {
    const db = getDb();
    const rows = await db
      .select({ category: events.category, value: count() })
      .from(events)
      .where(eq(events.appId, appId))
      .groupBy(events.category);
    return rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = Number(r.value);
      return acc;
    }, {});
  },

  /**
   * P0: Scoped to application. Never return cross-app counts.
   */
  async countSince(appId: string, since: Date): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ value: count() })
      .from(events)
      .where(
        and(
          eq(events.appId, appId),
          sql`${events.createdAt} >= ${since.toISOString()}`,
        ),
      );
    return Number(rows[0]?.value ?? 0);
  },
};
