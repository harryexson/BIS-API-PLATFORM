import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  userVerificationTokens,
  type UserVerificationToken,
  type NewUserVerificationToken,
} from '../schema';

export const userVerificationTokenRepository = {
  async findByTokenHash(tokenHash: string): Promise<UserVerificationToken | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(userVerificationTokens)
      .where(eq(userVerificationTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0];
  },

  async create(data: NewUserVerificationToken): Promise<UserVerificationToken> {
    const db = getDb();
    const rows = await db.insert(userVerificationTokens).values(data).returning();
    return rows[0];
  },

  async markUsed(id: string): Promise<UserVerificationToken | undefined> {
    const db = getDb();
    const rows = await db
      .update(userVerificationTokens)
      .set({ usedAt: new Date() })
      .where(eq(userVerificationTokens.id, id))
      .returning();
    return rows[0];
  },

  // Invalidates any outstanding, unused tokens of a given purpose for a
  // user — used when issuing a fresh token so an old reset/verification
  // link can't be used alongside a newer one.
  async invalidateOutstanding(userId: string, purpose: string): Promise<void> {
    const db = getDb();
    await db
      .update(userVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userVerificationTokens.userId, userId),
          eq(userVerificationTokens.purpose, purpose),
          isNull(userVerificationTokens.usedAt),
        ),
      );
  },
};
