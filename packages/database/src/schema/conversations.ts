import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { messagingProfiles } from './messaging-profiles';
import { tenantIdNonBlank } from './tenant-id-check';

/**
 * A conversation is ONE customer talking to ONE owner (application → tenant
 * → optional supplier/business) on ONE business number.
 *
 * Phase 8 (gap register A1/A2/D12) — shared phone numbers. The platform
 * deliberately shares one local number per country across many tenants
 * (Reach Church, Afribook, HaulPro, STAYSCAPE, EventHub Pro ...). Before
 * this phase the row had no idea WHICH number it was on: `phone_number` is
 * the CUSTOMER, so two tenants on the same shared number were
 * indistinguishable and inbound routing fell back to "most recent wins".
 *
 * Ownership fields (the certification spec's minimum list, mapped):
 *   conversation_id   → id
 *   phone_number      → phone_number    (the customer; there is no separate
 *                                        customer entity in this codebase, so
 *                                        the normalized number IS the
 *                                        customer identity — no customer_id)
 *   business number   → business_number (the platform-side number/short code
 *                                        the conversation happens on;
 *                                        normalized. NULL only for rows
 *                                        written before Phase 8 — never
 *                                        backfilled by guessing)
 *   provider          → provider_id
 *   country           → country         (from the messaging profile, if any)
 *   application_id    → app_id
 *   tenant_id         → tenant_id
 *   supplier/business → supplier_id     (suppliers.id; NULL = tenant-level)
 *   messaging profile → messaging_profile_id (the registration the business
 *                                        number was resolved from, if any)
 *   workflow_id       → workflow_id     (placeholder: no workflow engine
 *                                        exists in this codebase yet; stored
 *                                        verbatim, never interpreted)
 *   status            → status
 *   last_activity_at  → last_message_at (name kept to avoid a breaking rename)
 *
 * Unique key: (phone_number, business_number, app_id, tenant_id, supplier_id,
 * channel) with NULLS NOT DISTINCT. The same customer can legitimately hold
 * simultaneous active conversations with different tenants on the SAME
 * shared number (tenant differs), with two hotels of one STAYSCAPE tenant on
 * the same number (supplier differs), with one tenant on two different
 * numbers (business number differs), or with one owner over SMS and over
 * WhatsApp on the same number (channel differs) — and every one of those is
 * a distinct row. Provider is deliberately NOT in the key: a provider
 * failover within a channel must not fork the thread.
 *
 * Phase 16 (gap register D16): channel was added to the key. Phase 8 left
 * it out so that "a channel re-detection" would not fork a thread, but Phase
 * 10 made the channel explicit and continuity channel-scoped (routing reuses
 * only a thread on the channel being sent on). Without channel in the key an
 * SMS thread and a WhatsApp thread of one owner on one number were a single
 * row whose channel/provider flipped with every send, so the SMS thread
 * Phase 10's continuity looks for no longer existed after any WhatsApp send.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phoneNumber: text('phone_number').notNull(),
    businessNumber: text('business_number'),
    appId: text('app_id').notNull(),
    // P0 FIX: tenantId is now required for multi-tenant conversation isolation.
    // Within the same appId, different tenants must not share conversation state.
    // Phase 16: no DB default — an omitted tenant is a NOT NULL error, never
    // a silent 'default'.
    tenantId: text('tenant_id').notNull(),
    supplierId: text('supplier_id'),
    messagingProfileId: uuid('messaging_profile_id').references(() => messagingProfiles.id, {
      onDelete: 'set null',
    }),
    country: text('country'),
    workflowId: text('workflow_id'),
    providerId: text('provider_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('active'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_conversations_phone').on(t.phoneNumber),
    index('idx_conversations_app').on(t.appId),
    index('idx_conversations_tenant').on(t.tenantId),
    index('idx_conversations_provider').on(t.providerId),
    index('idx_conversations_status').on(t.status),
    index('idx_conversations_business_number').on(t.businessNumber),
    // Phase 8: replaces idx_conversations_phone_app_tenant (which could not
    // represent one customer talking to two tenants on two different
    // numbers, nor to two suppliers of one tenant).
    unique('uq_conversations_owner')
      .on(t.phoneNumber, t.businessNumber, t.appId, t.tenantId, t.supplierId, t.channel)
      .nullsNotDistinct(),
    tenantIdNonBlank('conversations', t.tenantId),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
