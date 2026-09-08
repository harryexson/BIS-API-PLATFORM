import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Master plan Phase 40/41 (A2P/10DLC compliance model). A MessagingProfile
 * ties a sender (phone/short code/alphanumeric/10DLC number) used by a
 * tenant's application in a given country to its regulatory registration
 * status and provider. Country-aware by design — this is not a US-10DLC-only
 * model; `senderType`/`complianceStatus` apply just as well to a Malawi
 * shortcode or a UK alphanumeric sender ID.
 *
 * Scope of this pass: the registration record and its CRUD surface. NOT in
 * scope: enforcing complianceStatus against outbound sends (e.g. blocking
 * a send from an unregistered 10DLC number), or integrating with a real
 * carrier/registrar API to verify status — those are real, larger pieces
 * of follow-up work, not silently assumed done by this table existing.
 */
export const messagingProfiles = pgTable(
  'messaging_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    country: text('country').notNull(), // ISO 3166-1 alpha-2, e.g. 'US', 'MW'
    senderType: text('sender_type').notNull(), // 'phone' | '10dlc' | 'tollfree' | 'shortcode' | 'alphanumeric'
    sender: text('sender').notNull(), // the actual number/code/alphanumeric ID
    provider: text('provider').notNull(), // provider id this sender is registered with
    campaignId: text('campaign_id'), // e.g. US 10DLC campaign ID
    brandId: text('brand_id'), // e.g. US 10DLC brand ID
    complianceStatus: text('compliance_status').notNull().default('unregistered'), // 'unregistered' | 'pending' | 'approved' | 'rejected' | 'suspended'
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_messaging_profiles_app').on(t.appId),
    index('idx_messaging_profiles_tenant').on(t.tenantId),
    index('idx_messaging_profiles_country').on(t.country),
    index('idx_messaging_profiles_compliance_status').on(t.complianceStatus),
    uniqueIndex('idx_messaging_profiles_app_tenant_sender_provider').on(
      t.appId,
      t.tenantId,
      t.sender,
      t.provider,
    ),
  ],
);

export type MessagingProfile = typeof messagingProfiles.$inferSelect;
export type NewMessagingProfile = typeof messagingProfiles.$inferInsert;
