import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../connection';
import { accessCredentials, type AccessCredential, type NewAccessCredential } from '../schema';

function generateToken(): string {
  return 'cred_' + randomUUID().replace(/-/g, '');
}

export const accessCredentialRepository = {
  async issue(
    data: Omit<NewAccessCredential, 'token'>,
  ): Promise<AccessCredential> {
    const db = getDb();
    const rows = await db
      .insert(accessCredentials)
      .values({ ...data, token: generateToken() })
      .returning();
    return rows[0];
  },

  async findById(id: string, appId: string): Promise<AccessCredential | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(accessCredentials)
      .where(and(eq(accessCredentials.id, id), eq(accessCredentials.appId, appId)))
      .limit(1);
    return rows[0];
  },

  /**
   * Looks up a credential by its opaque token *and* the scanning app's id —
   * a token minted for one application must never validate against another
   * application's scan, even though the token itself is globally unique.
   */
  async findByTokenForApp(token: string, appId: string): Promise<AccessCredential | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(accessCredentials)
      .where(and(eq(accessCredentials.token, token), eq(accessCredentials.appId, appId)))
      .limit(1);
    return rows[0];
  },

  async listByOwner(appId: string, tenantId: string, ownerType: string, ownerRef: string): Promise<AccessCredential[]> {
    const db = getDb();
    return db
      .select()
      .from(accessCredentials)
      .where(
        and(
          eq(accessCredentials.appId, appId),
          eq(accessCredentials.tenantId, tenantId),
          eq(accessCredentials.ownerType, ownerType),
          eq(accessCredentials.ownerRef, ownerRef),
        ),
      )
      .orderBy(desc(accessCredentials.issuedAt));
  },

  async listByAppAndTenant(appId: string, tenantId: string): Promise<AccessCredential[]> {
    const db = getDb();
    return db
      .select()
      .from(accessCredentials)
      .where(and(eq(accessCredentials.appId, appId), eq(accessCredentials.tenantId, tenantId)))
      .orderBy(desc(accessCredentials.issuedAt));
  },

  async revoke(id: string, appId: string): Promise<AccessCredential | undefined> {
    const db = getDb();
    const rows = await db
      .update(accessCredentials)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(accessCredentials.id, id), eq(accessCredentials.appId, appId)))
      .returning();
    return rows[0];
  },
};
