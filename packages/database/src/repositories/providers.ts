import { eq, desc, count } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  providers,
  type Provider,
  type NewProvider,
} from '../schema';

export const providerRepository = {
  async findById(id: string): Promise<Provider | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .limit(1);
    return rows[0];
  },

  async findBySlug(slug: string): Promise<Provider | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(providers)
      .where(eq(providers.slug, slug))
      .limit(1);
    return rows[0];
  },

  async findByCategory(category: string): Promise<Provider[]> {
    const db = getDb();
    return db
      .select()
      .from(providers)
      .where(eq(providers.category, category))
      .orderBy(desc(providers.createdAt));
  },

  async findAll(): Promise<Provider[]> {
    const db = getDb();
    return db.select().from(providers).orderBy(desc(providers.createdAt));
  },

  async create(data: NewProvider): Promise<Provider> {
    const db = getDb();
    const rows = await db.insert(providers).values(data).returning();
    return rows[0];
  },

  async update(
    id: string,
    data: Partial<NewProvider>,
  ): Promise<Provider | undefined> {
    const db = getDb();
    const rows = await db
      .update(providers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(providers.id, id))
      .returning();
    return rows[0];
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ value: count() }).from(providers);
    return rows[0]?.value ?? 0;
  },
};
