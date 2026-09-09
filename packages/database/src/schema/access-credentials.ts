import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * A single generic model backs every NFC/QR use case (event check-in,
 * asset/shipment tracking, membership/loyalty cards) rather than one table
 * per use case — they all reduce to "issue an opaque credential bound to an
 * owner, then verify a scan of it". `purpose` and `ownerType` distinguish
 * the use cases; `token` is the opaque value encoded into the QR payload or
 * written to the NFC tag and must never be a guessable/sequential ID.
 */
export const accessCredentials = pgTable(
  'access_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    token: text('token').notNull(),
    credentialType: text('credential_type').notNull().default('qr'),
    purpose: text('purpose').notNull(),
    ownerType: text('owner_type').notNull(),
    ownerRef: text('owner_ref').notNull(),
    label: text('label'),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('idx_access_credentials_token').on(t.token),
    index('idx_access_credentials_app_id').on(t.appId),
    index('idx_access_credentials_tenant_id').on(t.tenantId),
    index('idx_access_credentials_owner').on(t.ownerType, t.ownerRef),
    index('idx_access_credentials_status').on(t.status),
  ],
);

export type AccessCredential = typeof accessCredentials.$inferSelect;
export type NewAccessCredential = typeof accessCredentials.$inferInsert;
