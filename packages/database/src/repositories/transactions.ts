import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { transactions, type Transaction, type NewTransaction } from '../schema';

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

  async updateStatus(id: string, status: string): Promise<Transaction | undefined> {
    const db = getDb();
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
