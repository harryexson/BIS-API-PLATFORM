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
        and(
          eq(transactions.appId, appId),
          eq(transactions.tenantId, tenantId),
          eq(transactions.idempotencyKey, idempotencyKey),
        ),
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

  // P0: Real payment reconciliation (docs/IMPLEMENTATION_BASELINE.md §4
  // item 10) — finds transactions whose outcome this platform still
  // doesn't actually know: stuck in 'pending'/'processing' (the charge
  // was initiated but neither a synchronous response nor a webhook has
  // resolved it) or 'unknown' (a genuinely ambiguous provider timeout —
  // see TransactionStatus's doc comment in packages/schemas) for longer
  // than `olderThanMs`. Deliberately detection-and-reporting only, not
  // auto-resolution: guessing an outcome from internal state alone would
  // be exactly the kind of fabrication the master plan prohibits for a
  // real charge — only the provider (via its dashboard, support, or a
  // webhook this platform already ingests) actually knows what happened.
  async findStaleUnresolved(olderThanMs: number): Promise<Transaction[]> {
    const db = getDb();
    const { inArray, lt } = await import('drizzle-orm');
    const cutoff = new Date(Date.now() - olderThanMs);
    return db
      .select()
      .from(transactions)
      .where(
        and(
          inArray(transactions.status, ['pending', 'processing', 'unknown']),
          lt(transactions.updatedAt, cutoff),
        ),
      )
      .orderBy(transactions.updatedAt);
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(transactions);
    return rows[0]?.value ?? 0;
  },

  // Plan payment-volume-limit enforcement (services/api-gateway's
  // /v1/api/gateway/payment route): sums only 'success' transactions —
  // a failed or still-unresolved ('unknown') attempt never moved money,
  // so it must not count against the limit. Returned in the smallest
  // currency unit (cents) to match plans.paymentVolumeLimitCents;
  // transactions.amount is stored as a decimal major-unit string
  // (e.g. "250.00"), so this rounds each row rather than relying on a
  // cross-currency-safe cents column that doesn't exist yet — acceptable
  // for enforcement purposes, not for accounting reconciliation.
  async sumSuccessfulAmountCentsSince(appId: string, since: Date): Promise<number> {
    const db = getDb();
    const { sql } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.appId, appId),
          eq(transactions.status, 'success'),
          sql`${transactions.createdAt} >= ${since.toISOString()}`,
        ),
      );
    return rows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  },
};
