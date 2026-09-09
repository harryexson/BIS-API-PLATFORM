import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { supportTickets, type SupportTicket, type NewSupportTicket } from '../schema';

export const supportTicketRepository = {
  async findById(id: string, appId: string): Promise<SupportTicket | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.id, id), eq(supportTickets.appId, appId)))
      .limit(1);
    return rows[0];
  },

  async listByAppAndTenant(appId: string, tenantId: string): Promise<SupportTicket[]> {
    const db = getDb();
    return db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.appId, appId), eq(supportTickets.tenantId, tenantId)))
      .orderBy(desc(supportTickets.createdAt));
  },

  async create(data: NewSupportTicket): Promise<SupportTicket> {
    const db = getDb();
    const rows = await db.insert(supportTickets).values(data).returning();
    return rows[0];
  },

  async updateStatus(id: string, appId: string, status: string): Promise<SupportTicket | undefined> {
    const db = getDb();
    const rows = await db
      .update(supportTickets)
      .set({
        status,
        updatedAt: new Date(),
        resolvedAt: status === 'resolved' || status === 'closed' ? new Date() : null,
      })
      .where(and(eq(supportTickets.id, id), eq(supportTickets.appId, appId)))
      .returning();
    return rows[0];
  },
};
