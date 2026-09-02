import { eq, desc, and, lt, count } from 'drizzle-orm';
import { getDb } from '../connection';
import { outboxEvents, type OutboxEvent, type NewOutboxEvent } from '../schema';

/**
 * Threshold for stuck outbox events — if claimed but not completed within this time,
 * the event is reset to pending for retry.
 */
const STUCK_THRESHOLD_MS = 5 * 60_000; // 5 minutes

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

  /**
   * P0: Rescues stuck outbox events that were claimed but never completed.
   * Resets them to pending for retry.
   */
  async rescueStuck(batchLimit: number = 10): Promise<number> {
    const db = getDb();
    const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuckEvents = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'processing'),
          lt(outboxEvents.createdAt, stuckThreshold),
        ),
      )
      .limit(batchLimit);

    let rescued = 0;
    for (const stuck of stuckEvents) {
      await db
        .update(outboxEvents)
        .set({ status: 'pending', error: null })
        .where(eq(outboxEvents.id, stuck.id));
      rescued++;
    }
    return rescued;
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
