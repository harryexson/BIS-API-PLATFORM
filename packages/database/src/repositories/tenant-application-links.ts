import { eq, and, count } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  tenantApplicationLinks,
  type TenantApplicationLink,
  type NewTenantApplicationLink,
} from '../schema';

export const tenantApplicationLinkRepository = {
  async findByTenantAndApplication(
    tenantId: string,
    applicationId: string,
  ): Promise<TenantApplicationLink | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(tenantApplicationLinks)
      .where(
        eq(tenantApplicationLinks.tenantId, tenantId) &&
          eq(tenantApplicationLinks.applicationId, applicationId),
      )
      .limit(1);
    return rows[0];
  },

  async findByTenantId(tenantId: string): Promise<TenantApplicationLink[]> {
    const db = getDb();
    return db
      .select()
      .from(tenantApplicationLinks)
      .where(eq(tenantApplicationLinks.tenantId, tenantId));
  },

  async findByApplicationId(
    applicationId: string,
  ): Promise<TenantApplicationLink[]> {
    const db = getDb();
    return db
      .select()
      .from(tenantApplicationLinks)
      .where(eq(tenantApplicationLinks.applicationId, applicationId));
  },

  async create(
    data: NewTenantApplicationLink,
  ): Promise<TenantApplicationLink> {
    const db = getDb();
    const rows = await db
      .insert(tenantApplicationLinks)
      .values(data)
      .returning();
    return rows[0];
  },

  async link(
    tenantId: string,
    applicationId: string,
  ): Promise<TenantApplicationLink> {
    const existing = await this.findByTenantAndApplication(
      tenantId,
      applicationId,
    );
    if (existing) {
      if (existing.status === 'revoked') {
        const db = getDb();
        const rows = await db
          .update(tenantApplicationLinks)
          .set({ status: 'active' })
          .where(eq(tenantApplicationLinks.id, existing.id))
          .returning();
        return rows[0];
      }
      return existing;
    }
    return this.create({ tenantId, applicationId, status: 'active' });
  },

  async unlink(
    tenantId: string,
    applicationId: string,
  ): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(tenantApplicationLinks)
      .set({ status: 'revoked' })
      .where(
        eq(tenantApplicationLinks.tenantId, tenantId) &&
          eq(tenantApplicationLinks.applicationId, applicationId),
      )
      .returning();
    return rows.length > 0;
  },

  async isLinked(
    tenantId: string,
    applicationId: string,
  ): Promise<boolean> {
    const link = await this.findByTenantAndApplication(
      tenantId,
      applicationId,
    );
    return link?.status === 'active';
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ value: count() })
      .from(tenantApplicationLinks);
    return rows[0]?.value ?? 0;
  },
};
