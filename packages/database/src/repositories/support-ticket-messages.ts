import { eq, asc } from 'drizzle-orm';
import { getDb } from '../connection';
import { supportTicketMessages, type SupportTicketMessage, type NewSupportTicketMessage } from '../schema';

export const supportTicketMessageRepository = {
  async listByTicketId(ticketId: string): Promise<SupportTicketMessage[]> {
    const db = getDb();
    return db
      .select()
      .from(supportTicketMessages)
      .where(eq(supportTicketMessages.ticketId, ticketId))
      .orderBy(asc(supportTicketMessages.createdAt));
  },

  async create(data: NewSupportTicketMessage): Promise<SupportTicketMessage> {
    const db = getDb();
    const rows = await db.insert(supportTicketMessages).values(data).returning();
    return rows[0];
  },
};
