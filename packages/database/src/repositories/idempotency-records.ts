import { eq, and, gt } from 'drizzle-orm';
import { getDb } from '../connection';
import { idempotencyRecords, type IdempotencyRecord, type NewIdempotencyRecord } from '../schema';

export const idempotencyRecordRepository = {
  async findActive(
    appId: string,
    tenantId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(idempotencyRecords)
      .where(
        eq(idempotencyRecords.appId, appId) &&
        eq(idempotencyRecords.tenantId, tenantId) &&
        eq(idempotencyRecords.operation, operation) &&
        eq(idempotencyRecords.idempotencyKey, idempotencyKey) &&
        gt(idempotencyRecords.expiresAt, new Date()),
      )
      .limit(1);
    return rows[0];
  },

  async create(data: NewIdempotencyRecord): Promise<IdempotencyRecord> {
    const db = getDb();
    const rows = await db.insert(idempotencyRecords).values(data).returning();
    return rows[0];
  },

  async complete(id: string, result: any): Promise<void> {
    const db = getDb();
    await db
      .update(idempotencyRecords)
      .set({ status: 'completed', result })
      .where(eq(idempotencyRecords.id, id));
  },

  async fail(id: string, error: string): Promise<void> {
    const db = getDb();
    await db
      .update(idempotencyRecords)
      .set({ status: 'failed', result: { error } })
      .where(eq(idempotencyRecords.id, id));
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(idempotencyRecords);
    return rows[0]?.value ?? 0;
  },
};
