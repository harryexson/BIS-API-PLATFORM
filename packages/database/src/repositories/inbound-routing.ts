import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  inboundMessageHolds,
  senderOptOuts,
  type InboundMessageHold,
  type SenderOptOut,
} from '../schema';
import { normalizeMessagingAddress } from '../messaging-address';

/**
 * One owner an ambiguous inbound message could belong to. Recorded on the
 * hold so an operator can only ever attribute the message to an owner the
 * platform itself found plausible — never to an arbitrary tenant.
 */
export interface InboundHoldCandidate {
  appId: string;
  tenantId: string;
  supplierId: string | null;
  conversationId: string | null;
  /**
   * Phase 9: this candidate has an application-specific keyword command the
   * held message matches (e.g. only HaulPro configured WHERE IS MY DRIVER).
   * An operator HINT only — never used to route (see inboundMessage.ts).
   */
  matchedCommand?: string;
}

export type InboundHoldReason = 'ambiguous_owner' | 'no_owner';

export interface InboundHoldInput {
  dedupeKey: string;
  providerId: string;
  customerPhone: string;
  businessNumber: string | null;
  channel: string;
  content: string;
  keyword: string | null;
  reason: InboundHoldReason;
  candidates: InboundHoldCandidate[];
  rawPayload?: unknown;
}

export type InboundHoldResolveResult =
  | { outcome: 'resolved'; hold: InboundMessageHold }
  | { outcome: 'not_found' }
  | { outcome: 'not_pending'; status: string }
  | { outcome: 'not_a_candidate'; candidates: InboundHoldCandidate[] };

function sameOwner(c: InboundHoldCandidate, owner: { appId: string; tenantId: string; supplierId?: string | null }): boolean {
  return c.appId === owner.appId && c.tenantId === owner.tenantId && (c.supplierId ?? null) === (owner.supplierId ?? null);
}

export const inboundMessageHoldRepository = {
  /**
   * Quarantine an unattributable inbound message. Idempotent on dedupeKey:
   * a retried job gets the SAME hold back (created: false) rather than a
   * duplicate. The write is confirmed with a primary-key read before
   * returning (gap register PHASE5-01/02: postgres-js can settle a
   * statement before its implicit commit — a hold that silently failed to
   * commit would be exactly the silent drop this table exists to prevent).
   */
  async createOrGet(data: InboundHoldInput): Promise<{ hold: InboundMessageHold; created: boolean }> {
    const db = getDb();
    const inserted = await db
      .insert(inboundMessageHolds)
      .values({
        dedupeKey: data.dedupeKey,
        providerId: data.providerId,
        customerPhone: normalizeMessagingAddress(data.customerPhone),
        businessNumber: data.businessNumber ? normalizeMessagingAddress(data.businessNumber) : null,
        channel: data.channel,
        content: data.content,
        keyword: data.keyword,
        reason: data.reason,
        candidates: data.candidates,
        rawPayload: (data.rawPayload ?? null) as never,
      })
      .onConflictDoNothing({ target: inboundMessageHolds.dedupeKey })
      .returning();
    const created = Boolean(inserted[0]);
    const rows = await db
      .select()
      .from(inboundMessageHolds)
      .where(eq(inboundMessageHolds.dedupeKey, data.dedupeKey))
      .limit(1);
    if (!rows[0]) {
      throw new Error(`inbound hold ${data.dedupeKey} was not persisted — refusing to report it as held`);
    }
    return { hold: rows[0], created };
  },

  async findById(id: string): Promise<InboundMessageHold | undefined> {
    const db = getDb();
    const rows = await db.select().from(inboundMessageHolds).where(eq(inboundMessageHolds.id, id)).limit(1);
    return rows[0];
  },

  async markSenderOptOutApplied(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(inboundMessageHolds)
      .set({ senderOptOutApplied: true, updatedAt: new Date() })
      .where(eq(inboundMessageHolds.id, id));
  },

  async list(opts: { status?: string; limit?: number } = {}): Promise<InboundMessageHold[]> {
    const db = getDb();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const query = db.select().from(inboundMessageHolds);
    const filtered = opts.status ? query.where(eq(inboundMessageHolds.status, opts.status)) : query;
    return filtered.orderBy(desc(inboundMessageHolds.createdAt)).limit(limit);
  },

  async countByStatus(): Promise<Record<string, number>> {
    const db = getDb();
    const rows = await db
      .select({ status: inboundMessageHolds.status, value: sql<number>`count(*)::int` })
      .from(inboundMessageHolds)
      .groupBy(inboundMessageHolds.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.value)]));
  },

  /**
   * Operator attribution. Only a PENDING hold, and only to one of the
   * owners the platform itself recorded as candidates (an ambiguous hold) —
   * a 'no_owner' hold has no candidates and cannot be attributed through
   * this path. Single conditional UPDATE: two operators racing cannot both
   * resolve it.
   */
  async resolve(
    id: string,
    owner: { appId: string; tenantId: string; supplierId?: string | null },
    meta: { resolvedBy: string; note: string },
  ): Promise<InboundHoldResolveResult> {
    const current = await this.findById(id);
    if (!current) return { outcome: 'not_found' };
    if (current.status !== 'pending') return { outcome: 'not_pending', status: current.status };
    const candidates = (current.candidates ?? []) as InboundHoldCandidate[];
    if (!candidates.some((c) => sameOwner(c, owner))) {
      return { outcome: 'not_a_candidate', candidates };
    }
    const db = getDb();
    const now = new Date();
    const rows = await db
      .update(inboundMessageHolds)
      .set({
        status: 'resolved',
        resolvedAppId: owner.appId,
        resolvedTenantId: owner.tenantId,
        resolvedSupplierId: owner.supplierId ?? null,
        resolvedBy: meta.resolvedBy,
        resolutionNote: meta.note,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(eq(inboundMessageHolds.id, id), eq(inboundMessageHolds.status, 'pending')))
      .returning();
    if (!rows[0]) {
      const after = await this.findById(id);
      return { outcome: 'not_pending', status: after?.status ?? 'unknown' };
    }
    return { outcome: 'resolved', hold: rows[0] };
  },

  async discard(id: string, meta: { resolvedBy: string; note: string }): Promise<InboundMessageHold | undefined> {
    const db = getDb();
    const now = new Date();
    const rows = await db
      .update(inboundMessageHolds)
      .set({ status: 'discarded', resolvedBy: meta.resolvedBy, resolutionNote: meta.note, resolvedAt: now, updatedAt: now })
      .where(and(eq(inboundMessageHolds.id, id), eq(inboundMessageHolds.status, 'pending')))
      .returning();
    return rows[0];
  },

  /** resolved → delivered, after the worker has delivered it to the attributed owner. */
  async markDelivered(id: string): Promise<boolean> {
    const db = getDb();
    const now = new Date();
    const rows = await db
      .update(inboundMessageHolds)
      .set({ status: 'delivered', deliveredAt: now, updatedAt: now })
      .where(and(eq(inboundMessageHolds.id, id), eq(inboundMessageHolds.status, 'resolved')))
      .returning({ id: inboundMessageHolds.id });
    return rows.length > 0;
  },
};

export const senderOptOutRepository = {
  /**
   * Record the current number-level consent state for (business number,
   * recipient, channel). Single-statement upsert, confirmed by a read
   * (PHASE5-01/02) — a STOP must never be reported as recorded when it
   * was not.
   */
  async upsert(data: {
    businessNumber: string;
    recipient: string;
    channel: string;
    status: 'opted_out' | 'opted_in';
    source: string;
    keyword?: string | null;
    holdId?: string | null;
  }): Promise<SenderOptOut> {
    const db = getDb();
    const businessNumber = normalizeMessagingAddress(data.businessNumber);
    const recipient = normalizeMessagingAddress(data.recipient);
    if (!businessNumber || !recipient) {
      throw new Error('sender opt-out requires a business number and a recipient');
    }
    const now = new Date();
    await db
      .insert(senderOptOuts)
      .values({
        businessNumber,
        recipient,
        channel: data.channel,
        status: data.status,
        source: data.source,
        keyword: data.keyword ?? null,
        holdId: data.holdId ?? null,
      })
      .onConflictDoUpdate({
        target: [senderOptOuts.businessNumber, senderOptOuts.recipient, senderOptOuts.channel],
        set: {
          status: data.status,
          source: data.source,
          keyword: data.keyword ?? null,
          holdId: data.holdId ?? null,
          updatedAt: now,
        },
      });
    const row = await this.find(businessNumber, recipient, data.channel);
    if (!row || row.status !== data.status) {
      throw new Error(`sender opt-out for ${recipient} on ${businessNumber} was not persisted`);
    }
    return row;
  },

  async find(businessNumber: string, recipient: string, channel: string): Promise<SenderOptOut | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(senderOptOuts)
      .where(
        and(
          eq(senderOptOuts.businessNumber, normalizeMessagingAddress(businessNumber)),
          eq(senderOptOuts.recipient, normalizeMessagingAddress(recipient)),
          eq(senderOptOuts.channel, channel),
        ),
      )
      .limit(1);
    return rows[0];
  },

  async isOptedOut(businessNumber: string, recipient: string, channel: string): Promise<boolean> {
    const row = await this.find(businessNumber, recipient, channel);
    return row?.status === 'opted_out';
  },
};
