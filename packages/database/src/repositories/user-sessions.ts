import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  userSessions,
  type UserSession,
  type NewUserSession,
} from '../schema';

export const userSessionRepository = {
  async findByTokenHash(tokenHash: string): Promise<UserSession | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, tokenHash))
      .limit(1);
    return rows[0];
  },

  async findActiveByUserId(userId: string): Promise<UserSession[]> {
    const db = getDb();
    return db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  },

  async create(data: NewUserSession): Promise<UserSession> {
    const db = getDb();
    const rows = await db.insert(userSessions).values(data).returning();
    return rows[0];
  },

  async revoke(id: string): Promise<UserSession | undefined> {
    const db = getDb();
    const rows = await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.id, id))
      .returning();
    return rows[0];
  },

  async revokeAllForUser(userId: string): Promise<void> {
    const db = getDb();
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  },

  async updateLastUsed(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(userSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(userSessions.id, id));
  },
};
