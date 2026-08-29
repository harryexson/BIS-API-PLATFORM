import { eq, desc, count } from 'drizzle-orm';
import { getDb } from '../connection';
import { outboxEvents, type OutboxEvent, type NewOutboxEvent } from '../schema';

export const outboxEventRepository = {
  async create(data: NewOutboxEvent): Promise<OutboxEvent> {
    const db = getDb();
    const rows = await db.insert(outboxEvents).values(data).returning();
    return rows[0];
  },

  /**
   * Claim a batch of pending outbox events by updating their status to 'processing'.
   * Returns the claimed events (up to `limit`).
   */
  async claimBatch(batchLimit: number = 10): Promise<OutboxEvent[]> {
    const db = getDb();
    const rows = await db
      .update(outboxEvents)
      .set({ status: 'processing' })
      .where(eq(outboxEvents.status, 'pending'))
      .returning();
    return rows.slice(0, batchLimit);
  },

  async complete(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(outboxEvents)
      .set({ status: 'completed', processedAt: new Date() })
      .where(eq(outboxEvents.id, id));
  },

  async fail(id: string, error: string): Promise<void> {
    const db = getDb();
    await db
      .update(outboxEvents)
      .set({ status: 'failed', error })
      .where(eq(outboxEvents.id, id));
  },

  async findPending(): Promise<OutboxEvent[]> {
    const db = getDb();
    return db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'pending'))
      .orderBy(outboxEvents.createdAt);
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(outboxEvents);
    return rows[0]?.value ?? 0;
  },
};
