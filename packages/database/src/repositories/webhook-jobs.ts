import { eq, and, lt, count } from 'drizzle-orm';
import { getDb } from '../connection';
import { webhookJobs, type WebhookJob, type NewWebhookJob } from '../schema';

const STUCK_THRESHOLD_MS = 5 * 60_000; // 5 minutes

export const webhookJobRepository = {
  async create(data: NewWebhookJob): Promise<WebhookJob> {
    const db = getDb();
    const rows = await db.insert(webhookJobs).values(data).returning();
    return rows[0];
  },

  /**
   * Claim a batch of pending jobs by flipping them to 'processing'.
   * Returns the claimed rows (up to `batchLimit`).
   */
  async claimBatch(batchLimit: number = 10): Promise<WebhookJob[]> {
    const db = getDb();
    const rows = await db
      .update(webhookJobs)
      .set({ status: 'processing' })
      .where(eq(webhookJobs.status, 'pending'))
      .returning();
    return rows.slice(0, batchLimit);
  },

  async complete(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(webhookJobs)
      .set({ status: 'completed', processedAt: new Date() })
      .where(eq(webhookJobs.id, id));
  },

  async fail(id: string, error: string): Promise<void> {
    const db = getDb();
    await db
      .update(webhookJobs)
      .set({ status: 'failed', error })
      .where(eq(webhookJobs.id, id));
  },

  /**
   * Rescues jobs claimed but never completed (poller crashed mid-batch),
   * resetting them to pending for retry.
   */
  async rescueStuck(batchLimit: number = 10): Promise<number> {
    const db = getDb();
    const stuckThreshold = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await db
      .select()
      .from(webhookJobs)
      .where(
        and(
          eq(webhookJobs.status, 'processing'),
          lt(webhookJobs.createdAt, stuckThreshold),
        ),
      )
      .limit(batchLimit);

    let rescued = 0;
    for (const row of stuck) {
      await db
        .update(webhookJobs)
        .set({ status: 'pending', error: null })
        .where(eq(webhookJobs.id, row.id));
      rescued++;
    }
    return rescued;
  },

  async findPending(): Promise<WebhookJob[]> {
    const db = getDb();
    return db
      .select()
      .from(webhookJobs)
      .where(eq(webhookJobs.status, 'pending'))
      .orderBy(webhookJobs.createdAt);
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(webhookJobs);
    return rows[0]?.value ?? 0;
  },
};
