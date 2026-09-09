import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { accessCredentials } from './access-credentials';

/**
 * Append-only audit trail of every scan/verify attempt against a credential
 * (valid, expired, revoked, or unknown-token). This is what makes a
 * check-in/asset-scan/loyalty-tap auditable after the fact.
 */
export const credentialScans = pgTable(
  'credential_scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialId: uuid('credential_id').references(() => accessCredentials.id, { onDelete: 'set null' }),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    result: text('result').notNull(),
    scannedBy: text('scanned_by'),
    deviceInfo: text('device_info'),
    metadata: jsonb('metadata'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_credential_scans_credential_id').on(t.credentialId),
    index('idx_credential_scans_app_id').on(t.appId),
    index('idx_credential_scans_scanned_at').on(t.scannedAt),
  ],
);

export type CredentialScan = typeof credentialScans.$inferSelect;
export type NewCredentialScan = typeof credentialScans.$inferInsert;
