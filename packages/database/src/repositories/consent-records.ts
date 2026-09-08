import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { consentRecords, type ConsentRecord, type NewConsentRecord } from '../schema';

export const consentRecordRepository = {
  async findByRecipient(
    appId: string,
    tenantId: string,
    recipient: string,
    channel: string,
  ): Promise<ConsentRecord | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.appId, appId),
          eq(consentRecords.tenantId, tenantId),
          eq(consentRecords.recipient, recipient),
          eq(consentRecords.channel, channel),
        ),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * Set the current consent status for a recipient on a channel. Upserts
   * on (appId, tenantId, recipient, channel) — a recipient's consent state
   * is a single current value, not a log (the event trail already records
   * every keyword/API call that changed it via eventRepository).
   */
  async upsert(data: {
    appId: string;
    tenantId: string;
    recipient: string;
    channel: string;
    status: 'opted_in' | 'opted_out' | 'unknown';
    source: 'keyword' | 'api' | 'import';
    keyword?: string | null;
  }): Promise<ConsentRecord> {
    const existing = await this.findByRecipient(
      data.appId,
      data.tenantId,
      data.recipient,
      data.channel,
    );

    const db = getDb();
    if (existing) {
      const rows = await db
        .update(consentRecords)
        .set({
          status: data.status,
          source: data.source,
          keyword: data.keyword ?? null,
          updatedAt: new Date(),
        })
        .where(eq(consentRecords.id, existing.id))
        .returning();
      return rows[0];
    }

    const rows = await db
      .insert(consentRecords)
      .values({
        appId: data.appId,
        tenantId: data.tenantId,
        recipient: data.recipient,
        channel: data.channel,
        status: data.status,
        source: data.source,
        keyword: data.keyword ?? null,
      } satisfies NewConsentRecord)
      .returning();
    return rows[0];
  },

  /**
   * Whether outbound sends to this recipient/channel are currently
   * blocked. No record at all means "never opted out" — allowed. This is
   * the check the routing layer must call before dispatching.
   */
  async isOptedOut(
    appId: string,
    tenantId: string,
    recipient: string,
    channel: string,
  ): Promise<boolean> {
    const record = await this.findByRecipient(appId, tenantId, recipient, channel);
    return record?.status === 'opted_out';
  },

  async findByApplicationId(
    appId: string,
    limit: number = 100,
  ): Promise<ConsentRecord[]> {
    const db = getDb();
    return db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.appId, appId))
      .orderBy(desc(consentRecords.updatedAt))
      .limit(limit);
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(consentRecords);
    return rows[0]?.value ?? 0;
  },
};
