import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Phase 8 (gap register A3/A4) — inbound messages the platform could NOT
 * attribute to exactly one owner (application → tenant → supplier) on a
 * shared number.
 *
 * The certification spec: "If multiple possible contexts exist: DO NOT
 * GUESS ... Never route an inbound message to another tenant because its
 * conversation is newer." Such a message is neither delivered to any tenant
 * nor dropped: it is quarantined here, platform-side only (no tenant can
 * read this table — it is exposed solely on requireAdmin routes), until an
 * operator attributes it to one of the recorded `candidates`. Only then is
 * the content delivered and any keyword (STOP/YES/NO/...) applied — to the
 * attributed owner, never to a guess.
 *
 * reason:
 *   'ambiguous_owner' — more than one owner plausibly owns the message
 *   'no_owner'        — no owner at all (no profile for the destination
 *                       number and no conversation); previously this was a
 *                       silent console.warn-and-drop, including for STOP
 * status:  pending → resolved (operator chose an owner) → delivered
 *          pending → discarded (operator decided it belongs to nobody)
 */
export const inboundMessageHolds = pgTable(
  'inbound_message_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Idempotency for job retries: provider + provider message id (or the
    // job id when the provider gives none). A retried job never creates a
    // second hold, and never re-applies a sender-level opt-out twice.
    dedupeKey: text('dedupe_key').notNull(),
    providerId: text('provider_id').notNull(),
    customerPhone: text('customer_phone').notNull(),
    businessNumber: text('business_number'),
    channel: text('channel').notNull().default('sms'),
    content: text('content').notNull(),
    keyword: text('keyword'),
    reason: text('reason').notNull(),
    candidates: jsonb('candidates').notNull().default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('pending'),
    senderOptOutApplied: boolean('sender_opt_out_applied').notNull().default(false),
    rawPayload: jsonb('raw_payload'),
    resolvedAppId: text('resolved_app_id'),
    resolvedTenantId: text('resolved_tenant_id'),
    resolvedSupplierId: text('resolved_supplier_id'),
    resolvedBy: text('resolved_by'),
    resolutionNote: text('resolution_note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_inbound_holds_dedupe_key').on(t.dedupeKey),
    index('idx_inbound_holds_status').on(t.status),
    index('idx_inbound_holds_customer').on(t.customerPhone),
    check('chk_inbound_holds_status', sql`${t.status} IN ('pending', 'resolved', 'delivered', 'discarded')`),
    check('chk_inbound_holds_reason', sql`${t.reason} IN ('ambiguous_owner', 'no_owner')`),
  ],
);

/**
 * Phase 8 (gap register A4) — opt-out recorded at the SHARED-NUMBER level:
 * "recipient X must not receive anything from business number S".
 *
 * Carriers (e.g. Twilio Advanced Opt-Out, CTIA long-code rules) apply STOP
 * to the sender number as a whole, not to whichever tenant the platform
 * thinks the customer meant. This table mirrors that: it is written when a
 * STOP arrives on a shared number (always for an ambiguous STOP, where it is
 * the ONLY thing that can be honored without guessing a tenant), and the
 * outbound routing path refuses to send from S to X while it is
 * 'opted_out'. A JOIN/START on S clears it (the carrier re-enables the
 * number), but never touches any tenant's own consent_records row — a
 * tenant-level opt-out stays in force until that tenant's own JOIN.
 */
export const senderOptOuts = pgTable(
  'sender_opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessNumber: text('business_number').notNull(),
    recipient: text('recipient').notNull(),
    channel: text('channel').notNull().default('sms'),
    status: text('status').notNull(),
    source: text('source').notNull(),
    keyword: text('keyword'),
    holdId: uuid('hold_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_sender_opt_outs_number_recipient_channel').on(t.businessNumber, t.recipient, t.channel),
    check('chk_sender_opt_outs_status', sql`${t.status} IN ('opted_out', 'opted_in')`),
  ],
);

export type InboundMessageHold = typeof inboundMessageHolds.$inferSelect;
export type NewInboundMessageHold = typeof inboundMessageHolds.$inferInsert;
export type SenderOptOut = typeof senderOptOuts.$inferSelect;
export type NewSenderOptOut = typeof senderOptOuts.$inferInsert;
