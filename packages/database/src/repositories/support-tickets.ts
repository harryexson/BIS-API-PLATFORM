import { eq, desc, and } from 'drizzle-orm';
import { getDb } from '../connection';
import { supportTickets, type SupportTicket, type NewSupportTicket } from '../schema';

export const supportTicketRepository = {
  async findById(id: string): Promise<SupportTicket | undefined> {
    const db = getDb();
    const rows = await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
    return rows[0];
  },

  async findByApplicationId(applicationId: string): Promise<SupportTicket[]> {
    const db = getDb();
    return db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.applicationId, applicationId))
      .orderBy(desc(supportTickets.createdAt));
  },

  async findAll(status?: string): Promise<SupportTicket[]> {
    const db = getDb();
    const query = db.select().from(supportTickets);
    if (status) {
      return query.where(eq(supportTickets.status, status)).orderBy(desc(supportTickets.createdAt));
    }
    return query.orderBy(desc(supportTickets.createdAt));
  },

  async countOpenByApplicationId(applicationId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.applicationId, applicationId), eq(supportTickets.status, 'open')));
    return rows.length;
  },

  async create(data: NewSupportTicket): Promise<SupportTicket> {
    const db = getDb();
    const rows = await db.insert(supportTickets).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewSupportTicket>): Promise<SupportTicket | undefined> {
    const db = getDb();
    const rows = await db
      .update(supportTickets)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(supportTickets.id, id))
      .returning();
    return rows[0];
  },
};
