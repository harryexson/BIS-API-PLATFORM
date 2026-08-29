import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { suppliers, type Supplier, type NewSupplier } from '../schema';

export const supplierRepository = {
  async findById(id: string): Promise<Supplier | undefined> {
    const db = getDb();
    const rows = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    return rows[0];
  },

  async findByApplicationAndSlug(
    applicationId: string,
    tenantId: string,
    slug: string,
  ): Promise<Supplier | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(suppliers)
      .where(
        eq(suppliers.applicationId, applicationId) &&
        eq(suppliers.tenantId, tenantId) &&
        eq(suppliers.slug, slug),
      )
      .limit(1);
    return rows[0];
  },

  async create(data: NewSupplier): Promise<Supplier> {
    const db = getDb();
    const rows = await db.insert(suppliers).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewSupplier>): Promise<Supplier | undefined> {
    const db = getDb();
    const rows = await db
      .update(suppliers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    return rows[0];
  },

  async findByApplicationId(applicationId: string): Promise<Supplier[]> {
    const db = getDb();
    return db
      .select()
      .from(suppliers)
      .where(eq(suppliers.applicationId, applicationId))
      .orderBy(desc(suppliers.createdAt));
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(suppliers);
    return rows[0]?.value ?? 0;
  },
};
