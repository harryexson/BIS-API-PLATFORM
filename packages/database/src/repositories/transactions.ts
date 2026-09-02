import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { transactions, type Transaction, type NewTransaction } from '../schema';

/**
 * Valid payment states and allowed transitions.
 * Enforced to prevent invalid state mutations.
 */
const VALID_STATUSES = new Set(['pending', 'processing', 'success', 'failed', 'refunded', 'cancelled', 'unknown']);
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['processing', 'success', 'failed', 'cancelled', 'unknown'],
  processing: ['success', 'failed', 'refunded', 'unknown'],
  success: ['refunded'],
  failed: ['pending'],  // allow retry from failed
  refunded: [],
  cancelled: [],
  unknown: ['pending', 'success', 'failed', 'refunded'],  // reconciliation can resolve
};

export const transactionRepository = {
  async findById(id: string): Promise<Transaction | undefined> {
    const db = getDb();
    const rows = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    return rows[0];
  },

  async findByProviderTransactionId(providerTxId: string): Promise<Transaction | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.providerTransactionId, providerTxId))
      .limit(1);
    return rows[0];
  },

  async create(data: NewTransaction): Promise<Transaction> {
    const db = getDb();
    const rows = await db.insert(transactions).values(data).returning();
    return rows[0];
  },

  /**
   * P0: Updates transaction status with state machine validation.
   * Rejects invalid transitions to prevent data corruption.
   */
  async updateStatus(id: string, status: string): Promise<Transaction | undefined> {
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`Invalid transaction status: ${status}`);
    }

    const db = getDb();

    // Fetch current status for transition validation
    const current = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!current.length) return undefined;

    const currentStatus = current[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) {
      console.warn(
        `[transactions] Ignoring invalid transition: ${currentStatus} → ${status} for tx ${id}`,
      );
      return current[0];
    }

    const rows = await db
      .update(transactions)
      .set({ status, updatedAt: new Date() })
      .where(eq(transactions.id, id))
      .returning();
    return rows[0];
  },

  async findByAppAndIdempotencyKey(
    appId: string,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Transaction | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(transactions)
      .where(
        eq(transactions.appId, appId) &&
        eq(transactions.tenantId, tenantId) &&
        eq(transactions.idempotencyKey, idempotencyKey),
      )
      .limit(1);
    return rows[0];
  },

  async findByAppId(appId: string, limit: number = 50): Promise<Transaction[]> {
    const db = getDb();
    return db
      .select()
      .from(transactions)
      .where(eq(transactions.appId, appId))
      .orderBy(desc(transactions.createdAt))
      .limit(limit);
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(transactions);
    return rows[0]?.value ?? 0;
  },
};
