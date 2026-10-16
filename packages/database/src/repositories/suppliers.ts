import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { suppliers, type Supplier, type NewSupplier } from '../schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const supplierRepository = {
  async findById(id: string): Promise<Supplier | undefined> {
    // A malformed id is "not found", not a Postgres uuid cast error (500).
    if (!UUID_RE.test(id)) return undefined;
    const db = getDb();
    const rows = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    return rows[0];
  },

  async findByApplicationAndSlug(
    applicationId: string,
    tenantId: string,
    slug: string,
  ): Promise<Supplier | undefined> {
    if (!UUID_RE.test(applicationId)) return undefined;
    const db = getDb();
    const rows = await db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.applicationId, applicationId),
          eq(suppliers.tenantId, tenantId),
          eq(suppliers.slug, slug),
        ),
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

  // Phase 7 (F3.8): the tenant-scoped list SupplierScope.listOwnedSuppliers
  // uses. applicationId is the application's UUID (suppliers.application_id
  // is a UUID FK), never the slug.
  async findByApplicationAndTenant(applicationId: string, tenantId: string): Promise<Supplier[]> {
    if (!UUID_RE.test(applicationId)) return [];
    const db = getDb();
    return db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.applicationId, applicationId), eq(suppliers.tenantId, tenantId)))
      .orderBy(desc(suppliers.createdAt));
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
