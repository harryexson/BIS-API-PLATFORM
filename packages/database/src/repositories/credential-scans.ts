import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { credentialScans, type CredentialScan, type NewCredentialScan } from '../schema';

export const credentialScanRepository = {
  async record(data: NewCredentialScan): Promise<CredentialScan> {
    const db = getDb();
    const rows = await db.insert(credentialScans).values(data).returning();
    return rows[0];
  },

  async listByCredentialId(credentialId: string, appId: string): Promise<CredentialScan[]> {
    const db = getDb();
    return db
      .select()
      .from(credentialScans)
      .where(and(eq(credentialScans.credentialId, credentialId), eq(credentialScans.appId, appId)))
      .orderBy(desc(credentialScans.scannedAt));
  },
};
