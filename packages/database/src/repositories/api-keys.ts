import { eq, desc, count } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  applicationApiKeys,
  type ApplicationApiKey,
  type NewApplicationApiKey,
} from '../schema';

export const apiKeyRepository = {
  async findById(id: string): Promise<ApplicationApiKey | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applicationApiKeys)
      .where(eq(applicationApiKeys.id, id))
      .limit(1);
    return rows[0];
  },

  async findByHash(keyHash: string): Promise<ApplicationApiKey | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applicationApiKeys)
      .where(eq(applicationApiKeys.keyHash, keyHash))
      .limit(1);
    return rows[0];
  },

  async findByPrefix(prefix: string): Promise<ApplicationApiKey | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applicationApiKeys)
      .where(eq(applicationApiKeys.prefix, prefix))
      .limit(1);
    return rows[0];
  },

  async findByApplicationId(
    applicationId: string,
  ): Promise<ApplicationApiKey[]> {
    const db = getDb();
    return db
      .select()
      .from(applicationApiKeys)
      .where(eq(applicationApiKeys.applicationId, applicationId))
      .orderBy(desc(applicationApiKeys.createdAt));
  },

  async create(data: NewApplicationApiKey): Promise<ApplicationApiKey> {
    const db = getDb();
    const rows = await db.insert(applicationApiKeys).values(data).returning();
    return rows[0];
  },

  async revoke(id: string): Promise<ApplicationApiKey | undefined> {
    const db = getDb();
    const rows = await db
      .update(applicationApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(applicationApiKeys.id, id))
      .returning();
    return rows[0];
  },

  async updateLastUsed(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(applicationApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(applicationApiKeys.id, id));
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(applicationApiKeys);
    return rows[0]?.value ?? 0;
  },
};
