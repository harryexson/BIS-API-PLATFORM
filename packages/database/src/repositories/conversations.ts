import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { conversations, type Conversation, type NewConversation } from '../schema';

export const conversationRepository = {
  /**
   * P0 FIX: Look up conversation by (phoneNumber, appId, tenantId).
   * Previously this only used (phoneNumber, appId), causing cross-tenant bleed.
   */
  async findByPhoneAndApp(
    phoneNumber: string,
    appId: string,
    tenantId: string = 'default',
  ): Promise<Conversation | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(conversations)
      .where(
        eq(conversations.phoneNumber, phoneNumber) &&
          eq(conversations.appId, appId) &&
          eq(conversations.tenantId, tenantId),
      )
      .limit(1);
    return rows[0];
  },

  async findActiveByPhone(
    phoneNumber: string,
  ): Promise<Conversation[]> {
    const db = getDb();
    return db
      .select()
      .from(conversations)
      .where(
        eq(conversations.phoneNumber, phoneNumber) &&
          eq(conversations.status, 'active'),
      )
      .orderBy(desc(conversations.lastMessageAt));
  },

  /**
   * P0 FIX: Upsert now includes tenantId in the lookup key.
   * Two tenants sharing the same phone number within one app get separate conversations.
   */
  async upsert(
    phoneNumber: string,
    appId: string,
    data: { providerId: string; channel: string; tenantId: string },
  ): Promise<Conversation> {
    const existing = await this.findByPhoneAndApp(phoneNumber, appId, data.tenantId);
    if (existing) {
      const db = getDb();
      const rows = await db
        .update(conversations)
        .set({
          providerId: data.providerId,
          channel: data.channel,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, existing.id))
        .returning();
      return rows[0];
    }

    const db = getDb();
    const rows = await db
      .insert(conversations)
      .values({
        phoneNumber,
        appId,
        tenantId: data.tenantId,
        providerId: data.providerId,
        channel: data.channel,
      })
      .returning();
    return rows[0];
  },

  /**
   * P0 FIX: Close now includes tenantId to only close the correct tenant's conversation.
   */
  async close(phoneNumber: string, appId: string, tenantId: string = 'default'): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(conversations)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(
        eq(conversations.phoneNumber, phoneNumber) &&
          eq(conversations.appId, appId) &&
          eq(conversations.tenantId, tenantId),
      )
      .returning();
    return rows.length > 0;
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db
      .select({ value: count() })
      .from(conversations);
    return rows[0]?.value ?? 0;
  },
};
