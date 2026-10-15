import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { messagingProfiles, type MessagingProfile, type NewMessagingProfile } from '../schema';
import { normalizeMessagingAddress } from '../messaging-address';

const VALID_COMPLIANCE_STATUSES = new Set(['unregistered', 'pending', 'approved', 'rejected', 'suspended']);
const VALID_SENDER_TYPES = new Set(['phone', '10dlc', 'tollfree', 'shortcode', 'alphanumeric']);

export const messagingProfileRepository = {
  async findById(id: string): Promise<MessagingProfile | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(messagingProfiles)
      .where(eq(messagingProfiles.id, id))
      .limit(1);
    return rows[0];
  },

  async findBySender(
    appId: string,
    tenantId: string,
    sender: string,
    provider: string,
  ): Promise<MessagingProfile | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(messagingProfiles)
      .where(
        and(
          eq(messagingProfiles.appId, appId),
          eq(messagingProfiles.tenantId, tenantId),
          eq(messagingProfiles.sender, normalizeMessagingAddress(sender)),
          eq(messagingProfiles.provider, provider),
        ),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * Phase 8 (gap register A1/A2): provider → destination number → owners.
   * Every registration of this exact sender with this provider, whatever
   * its compliance status — ownership of INBOUND traffic (and of a STOP in
   * particular) does not lapse because a 10DLC campaign is pending or
   * suspended. Deterministic order (id), never recency.
   */
  async findOwnersOfSender(sender: string, provider: string): Promise<MessagingProfile[]> {
    const normalized = normalizeMessagingAddress(sender);
    if (!normalized) return [];
    const db = getDb();
    return db
      .select()
      .from(messagingProfiles)
      .where(and(eq(messagingProfiles.sender, normalized), eq(messagingProfiles.provider, provider)))
      .orderBy(messagingProfiles.id);
  },

  /**
   * Phase 8: the sender(s) an owner is registered to send from with a given
   * provider (outbound side of the same mapping). Deterministic order.
   */
  async findSendersForOwner(appId: string, tenantId: string, provider: string): Promise<MessagingProfile[]> {
    const db = getDb();
    return db
      .select()
      .from(messagingProfiles)
      .where(
        and(
          eq(messagingProfiles.appId, appId),
          eq(messagingProfiles.tenantId, tenantId),
          eq(messagingProfiles.provider, provider),
        ),
      )
      .orderBy(messagingProfiles.id);
  },

  // Phase 7 (gap register F3.2): tenant-scoped. This was
  // findByApplicationId(appId), which the tenant-authenticated gateway list
  // route used — returning every tenant's sender registrations (numbers,
  // 10DLC campaign/brand ids) under the application to any one tenant.
  async findByAppAndTenant(appId: string, tenantId: string, limit: number = 100): Promise<MessagingProfile[]> {
    const db = getDb();
    return db
      .select()
      .from(messagingProfiles)
      .where(and(eq(messagingProfiles.appId, appId), eq(messagingProfiles.tenantId, tenantId)))
      .orderBy(desc(messagingProfiles.createdAt))
      .limit(limit);
  },

  async create(data: {
    appId: string;
    tenantId: string;
    country: string;
    senderType: string;
    sender: string;
    provider: string;
    campaignId?: string | null;
    brandId?: string | null;
    complianceStatus?: string;
    supplierId?: string | null;
  }): Promise<MessagingProfile> {
    if (!VALID_SENDER_TYPES.has(data.senderType)) {
      throw new Error(`Invalid senderType: ${data.senderType}`);
    }
    const complianceStatus = data.complianceStatus ?? 'unregistered';
    if (!VALID_COMPLIANCE_STATUSES.has(complianceStatus)) {
      throw new Error(`Invalid complianceStatus: ${complianceStatus}`);
    }
    const sender = normalizeMessagingAddress(data.sender);
    if (!sender) {
      throw new Error('Invalid sender: must be a non-empty number, short code or sender ID');
    }

    const db = getDb();
    const rows = await db
      .insert(messagingProfiles)
      .values({
        appId: data.appId,
        tenantId: data.tenantId,
        country: data.country,
        senderType: data.senderType,
        sender,
        provider: data.provider,
        supplierId: data.supplierId ?? null,
        campaignId: data.campaignId ?? null,
        brandId: data.brandId ?? null,
        complianceStatus,
      } satisfies NewMessagingProfile)
      .returning();
    return rows[0];
  },

  async updateComplianceStatus(id: string, status: string): Promise<MessagingProfile | undefined> {
    if (!VALID_COMPLIANCE_STATUSES.has(status)) {
      throw new Error(`Invalid complianceStatus: ${status}`);
    }
    const db = getDb();
    const rows = await db
      .update(messagingProfiles)
      .set({ complianceStatus: status, updatedAt: new Date() })
      .where(eq(messagingProfiles.id, id))
      .returning();
    return rows[0];
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(messagingProfiles);
    return rows[0]?.value ?? 0;
  },
};
