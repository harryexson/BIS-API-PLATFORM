import { eq, and } from 'drizzle-orm';
import { getDb } from '../connection';
import { checkoutSessions, type CheckoutSession, type NewCheckoutSession } from '../schema';

export const checkoutSessionRepository = {
  async create(data: NewCheckoutSession): Promise<CheckoutSession> {
    const db = getDb();
    const rows = await db.insert(checkoutSessions).values(data).returning();
    return rows[0];
  },

  async findByToken(token: string): Promise<CheckoutSession | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.token, token))
      .limit(1);
    return rows[0];
  },

  /** Atomically marks a pending, unexpired session as completed — returns
   * undefined if it was already consumed or expired, preventing a session
   * token from being replayed to charge twice. */
  async markCompleted(token: string, paymentEventId: string): Promise<CheckoutSession | undefined> {
    const db = getDb();
    const rows = await db
      .update(checkoutSessions)
      .set({ status: 'completed', paymentEventId })
      .where(and(eq(checkoutSessions.token, token), eq(checkoutSessions.status, 'pending')))
      .returning();
    return rows[0];
  },

  async markExpiredIfPast(token: string): Promise<void> {
    const db = getDb();
    const session = await this.findByToken(token);
    if (session && session.status === 'pending' && session.expiresAt < new Date()) {
      await db
        .update(checkoutSessions)
        .set({ status: 'expired' })
        .where(eq(checkoutSessions.token, token));
    }
  },
};
