import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { messagingProfiles, type MessagingProfile, type NewMessagingProfile } from '../schema';

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
          eq(messagingProfiles.sender, sender),
          eq(messagingProfiles.provider, provider),
        ),
      )
      .limit(1);
    return rows[0];
  },

  async findByApplicationId(appId: string, limit: number = 100): Promise<MessagingProfile[]> {
    const db = getDb();
    return db
      .select()
      .from(messagingProfiles)
      .where(eq(messagingProfiles.appId, appId))
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
  }): Promise<MessagingProfile> {
    if (!VALID_SENDER_TYPES.has(data.senderType)) {
      throw new Error(`Invalid senderType: ${data.senderType}`);
    }
    const complianceStatus = data.complianceStatus ?? 'unregistered';
    if (!VALID_COMPLIANCE_STATUSES.has(complianceStatus)) {
      throw new Error(`Invalid complianceStatus: ${complianceStatus}`);
    }

    const db = getDb();
    const rows = await db
      .insert(messagingProfiles)
      .values({
        appId: data.appId,
        tenantId: data.tenantId,
        country: data.country,
        senderType: data.senderType,
        sender: data.sender,
        provider: data.provider,
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
