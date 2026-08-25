import { desc, eq, count, sql } from 'drizzle-orm';
import { getDb } from '../connection';
import { events, type EventRecord, type NewEventRecord } from '../schema';

export const eventRepository = {
  async create(data: NewEventRecord): Promise<EventRecord> {
    const db = getDb();
    const rows = await db.insert(events).values(data).returning();
    return rows[0];
  },

  async findLatest(limit = 100): Promise<EventRecord[]> {
    const db = getDb();
    return db.select().from(events).orderBy(desc(events.createdAt)).limit(limit);
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

  async countByCategory(): Promise<Record<string, number>> {
    const db = getDb();
    const rows = await db
      .select({ category: events.category, value: count() })
      .from(events)
      .groupBy(events.category);
    return rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.category] = Number(r.value);
      return acc;
    }, {});
  },

  async countSince(since: Date): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ value: count() })
      .from(events)
      .where(sql`${events.createdAt} >= ${since.toISOString()}`);
    return Number(rows[0]?.value ?? 0);
  },
};
