import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { getDb } from '../connection';
import { conversations, type Conversation } from '../schema';
import { normalizeMessagingAddress } from '../messaging-address';

/**
 * Data recorded on a conversation by an outbound send (or by an inbound
 * message the resolver attributed to exactly one owner).
 *
 * Phase 8: `businessNumber`, `supplierId`, `messagingProfileId`, `country`
 * and `workflowId` are new and optional — a caller that knows nothing about
 * them (every pre-Phase-8 caller) keeps exactly its previous behaviour, with
 * the conversation recorded on the NULL ("not recorded") business number.
 */
export interface ConversationUpsertData {
  providerId: string;
  channel: string;
  tenantId: string;
  supplierId?: string | null;
  businessNumber?: string | null;
  messagingProfileId?: string | null;
  country?: string | null;
  workflowId?: string | null;
}

function nullableAddress(value: string | null | undefined): string | null {
  const normalized = normalizeMessagingAddress(value ?? '');
  return normalized === '' ? null : normalized;
}

export const conversationRepository = {
  /**
   * The most recently active conversation for (customer, app, tenant), on
   * any business number / supplier. Kept for pre-Phase-8 callers; an owner
   * with conversations on several numbers should use findActiveForOwner.
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
        and(
          eq(conversations.phoneNumber, normalizeMessagingAddress(phoneNumber)),
          eq(conversations.appId, appId),
          eq(conversations.tenantId, tenantId),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);
    return rows[0];
  },

  /**
   * Phase 8: active conversations of ONE owner (app, tenant, and — when
   * given — supplier) with a customer, most recent first. Recency here only
   * ever chooses between threads of the SAME owner (e.g. which of its own
   * numbers to continue on), never between tenants.
   */
  async findActiveForOwner(
    phoneNumber: string,
    owner: { appId: string; tenantId: string; supplierId?: string | null },
  ): Promise<Conversation[]> {
    const db = getDb();
    return db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.phoneNumber, normalizeMessagingAddress(phoneNumber)),
          eq(conversations.appId, owner.appId),
          eq(conversations.tenantId, owner.tenantId),
          owner.supplierId ? eq(conversations.supplierId, owner.supplierId) : isNull(conversations.supplierId),
          eq(conversations.status, 'active'),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt));
  },

  /**
   * Every active conversation for a customer number, across ALL owners.
   * Only the inbound ConversationResolver should call this, and it never
   * uses the ordering to pick an owner (Phase 8 / gap register A3).
   */
  async findActiveByPhone(
    phoneNumber: string,
  ): Promise<Conversation[]> {
    const db = getDb();
    return db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.phoneNumber, normalizeMessagingAddress(phoneNumber)),
          eq(conversations.status, 'active'),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt));
  },

  /**
   * Record activity on the conversation identified by its full ownership
   * key (customer, business number, app, tenant, supplier).
   *
   * Single-statement INSERT ... ON CONFLICT DO UPDATE on uq_conversations_owner
   * (gap register A15: this used to be select-then-insert, so two concurrent
   * first sends raced on the unique index and one was swallowed).
   *
   * Legacy adoption: when the business number is known and the owner has a
   * pre-Phase-8 row with NO recorded number (and no row on this number yet),
   * that row is stamped with the number instead of forking a second thread.
   * This is the only way a legacy row ever acquires a number — by the
   * owner's own outbound send on it, never by a guess.
   */
  async upsert(
    phoneNumber: string,
    appId: string,
    data: ConversationUpsertData,
  ): Promise<Conversation> {
    const db = getDb();
    const customer = normalizeMessagingAddress(phoneNumber);
    const businessNumber = nullableAddress(data.businessNumber);
    const supplierId = data.supplierId || null;
    const now = new Date();

    const optional = {
      ...(data.messagingProfileId !== undefined ? { messagingProfileId: data.messagingProfileId } : {}),
      ...(data.country !== undefined ? { country: data.country } : {}),
      ...(data.workflowId !== undefined ? { workflowId: data.workflowId } : {}),
    };

    if (businessNumber) {
      try {
        const adopted = await db
          .update(conversations)
          .set({
            businessNumber,
            providerId: data.providerId,
            channel: data.channel,
            lastMessageAt: now,
            updatedAt: now,
            ...optional,
          })
          .where(
            and(
              eq(conversations.phoneNumber, customer),
              eq(conversations.appId, appId),
              eq(conversations.tenantId, data.tenantId),
              supplierId ? eq(conversations.supplierId, supplierId) : isNull(conversations.supplierId),
              isNull(conversations.businessNumber),
              sql`NOT EXISTS (
                SELECT 1 FROM ${conversations} AS c2
                WHERE c2.phone_number = ${customer} AND c2.app_id = ${appId}
                  AND c2.tenant_id = ${data.tenantId}
                  AND c2.supplier_id IS NOT DISTINCT FROM ${supplierId}
                  AND c2.business_number = ${businessNumber}
              )`,
            ),
          )
          .returning();
        if (adopted[0]) return adopted[0];
      } catch {
        // A concurrent writer created the numbered row between the NOT
        // EXISTS check and this UPDATE (unique violation): fall through to
        // the ON CONFLICT upsert below, which then updates that row.
      }
    }

    const rows = await db
      .insert(conversations)
      .values({
        phoneNumber: customer,
        businessNumber,
        appId,
        tenantId: data.tenantId,
        supplierId,
        providerId: data.providerId,
        channel: data.channel,
        ...optional,
      })
      .onConflictDoUpdate({
        target: [
          conversations.phoneNumber,
          conversations.businessNumber,
          conversations.appId,
          conversations.tenantId,
          conversations.supplierId,
        ],
        set: {
          providerId: data.providerId,
          channel: data.channel,
          lastMessageAt: now,
          updatedAt: now,
          ...optional,
        },
      })
      .returning();
    return rows[0];
  },

  /** Phase 8: touch a conversation the inbound resolver attributed a message to. */
  async touch(id: string): Promise<void> {
    const db = getDb();
    const now = new Date();
    await db
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, id));
  },

  /**
   * Phase 9: record the workflow an app-specific keyword command started on
   * the conversation it arrived on (the conversations.workflow_id Phase 8
   * reserved). Stored verbatim; the owning application interprets it.
   */
  async setWorkflow(id: string, workflowId: string | null): Promise<void> {
    const db = getDb();
    await db
      .update(conversations)
      .set({ workflowId, updatedAt: new Date() })
      .where(eq(conversations.id, id));
  },

  /**
   * P0 FIX: Close now includes tenantId to only close the correct tenant's
   * conversation(s) — every business number / supplier thread of that owner.
   */
  async close(phoneNumber: string, appId: string, tenantId: string = 'default'): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(conversations)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(
        and(
          eq(conversations.phoneNumber, normalizeMessagingAddress(phoneNumber)),
          eq(conversations.appId, appId),
          eq(conversations.tenantId, tenantId),
        ),
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
