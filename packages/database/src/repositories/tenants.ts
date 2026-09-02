import { eq, desc, count } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  tenants,
  tenantApplicationLinks,
  type Tenant,
  type NewTenant,
} from '../schema';

export const tenantRepository = {
  async findById(id: string): Promise<Tenant | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    return rows[0];
  },

  async findBySlug(slug: string): Promise<Tenant | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    return rows[0];
  },

  async findByApplicationId(applicationId: string): Promise<Tenant[]> {
    const db = getDb();
    const rows = await db
      .select({ tenant: tenants })
      .from(tenants)
      .innerJoin(
        tenantApplicationLinks,
        eq(tenants.id, tenantApplicationLinks.tenantId),
      )
      .where(eq(tenantApplicationLinks.applicationId, applicationId))
      .orderBy(desc(tenants.createdAt));
    return rows.map((r) => r.tenant);
  },

  async findActiveByApplicationId(applicationId: string): Promise<Tenant[]> {
    const db = getDb();
    const rows = await db
      .select({ tenant: tenants })
      .from(tenants)
      .innerJoin(
        tenantApplicationLinks,
        eq(tenants.id, tenantApplicationLinks.tenantId),
      )
      .where(
        eq(tenantApplicationLinks.applicationId, applicationId) &&
          eq(tenantApplicationLinks.status, 'active'),
      )
      .orderBy(desc(tenants.createdAt));
    return rows.map((r) => r.tenant);
  },

  async create(data: NewTenant): Promise<Tenant> {
    const db = getDb();
    const rows = await db.insert(tenants).values(data).returning();
    return rows[0];
  },

  async update(
    id: string,
    data: Partial<NewTenant>,
  ): Promise<Tenant | undefined> {
    const db = getDb();
    const rows = await db
      .update(tenants)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(tenants.id, id))
      .returning();
    return rows[0];
  },

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(tenants)
      .where(eq(tenants.id, id))
      .returning();
    return rows.length > 0;
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(tenants);
    return rows[0]?.value ?? 0;
  },
};
