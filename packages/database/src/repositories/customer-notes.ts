import { eq, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { customerNotes, type CustomerNote, type NewCustomerNote } from '../schema';

export const customerNoteRepository = {
  async findByApplicationId(applicationId: string): Promise<CustomerNote[]> {
    const db = getDb();
    return db
      .select()
      .from(customerNotes)
      .where(eq(customerNotes.applicationId, applicationId))
      .orderBy(desc(customerNotes.createdAt));
  },

  async create(data: NewCustomerNote): Promise<CustomerNote> {
    const db = getDb();
    const rows = await db.insert(customerNotes).values(data).returning();
    return rows[0];
  },
};
