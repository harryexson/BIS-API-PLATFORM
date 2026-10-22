import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { tenantIdNonBlank } from './tenant-id-check';

/**
 * Registration record for an outbound platform webhook (a developer's own
 * callback URL that receives a signed TransactionEvent as it happens).
 * Delivery is driven by services/api-gateway subscribing to EventBus and
 * enqueueing a matching, active row here into
 * packages/events/src/webhook-delivery.ts's WebhookDelivery — see
 * docs/IMPLEMENTATION_BASELINE.md item 24 for the history of this feature
 * (the delivery engine existed and worked before this table did; nothing
 * supplied it a target).
 *
 * Scoped by (appId, tenantId) for EVERYTHING — registration, listing,
 * deletion and delivery fan-out (Phase 7, gap register C4/F3.2). Before
 * Phase 7 TransactionEvent carried no tenantId, so delivery keyed on appId
 * alone and every tenant of an application received every other tenant's
 * events; TransactionEvent.tenantId now exists and the gateway dispatches an
 * event only to the endpoints of the event's own (appId, tenantId).
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    url: text('url').notNull(),
    // AES-256-GCM (packages/database/src/crypto.ts), same shape as
    // provider_configs' secret columns. Unlike a provider credential this
    // platform sends out, the raw value here must also be handed back to
    // the developer once (to configure their own verifier), but is never
    // re-displayed after creation — only decrypted server-side at
    // delivery time to compute the signature.
    encryptedSecret: text('encrypted_secret').notNull(),
    secretIv: text('secret_iv').notNull(),
    secretTag: text('secret_tag').notNull(),
    // TransactionEvent.category values this endpoint wants ('payment' |
    // 'messaging' | 'other'), or ['*'] for every category.
    eventTypes: jsonb('event_types').notNull().default(['*']),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_webhook_endpoints_app').on(t.appId),
    index('idx_webhook_endpoints_tenant').on(t.tenantId),
    index('idx_webhook_endpoints_active').on(t.active),
    tenantIdNonBlank('webhook_endpoints', t.tenantId),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
