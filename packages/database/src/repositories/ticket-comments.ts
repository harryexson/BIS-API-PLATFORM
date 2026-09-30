import { eq, asc } from 'drizzle-orm';
import { getDb } from '../connection';
import { ticketComments, type TicketComment, type NewTicketComment } from '../schema';

export const ticketCommentRepository = {
  async findByTicketId(ticketId: string): Promise<TicketComment[]> {
    const db = getDb();
    return db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, ticketId))
      .orderBy(asc(ticketComments.createdAt));
  },

  async create(data: NewTicketComment): Promise<TicketComment> {
    const db = getDb();
    const rows = await db.insert(ticketComments).values(data).returning();
    return rows[0];
  },
};
