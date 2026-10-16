import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  unique,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { conversations } from './conversations';

/**
 * Phase 9 (gap register A13) — tenant-configurable inbound keyword commands.
 *
 * Before this phase every keyword and every reply lived hard-coded in the
 * shared routing package, so church wording ("PRAY (prayer request)") was
 * advertised in the HELP reply of every tenant on the platform, HaulPro's
 * truck customers included, and app-specific commands such as CHECK IN or
 * WHERE IS MY DRIVER did not exist at all.
 *
 * Model:
 *  - Universal compliance keywords (STOP / START / HELP, plus the YES / NO
 *    confirmation pair) are ALWAYS recognised by the platform with fixed
 *    consent semantics. A row here whose `keyword` is one of RESERVED_KEYWORDS
 *    may only change the REPLY WORDING (action 'reply'); it can never turn
 *    STOP into anything but an opt-out.
 *  - Every other keyword is application/tenant-specific:
 *      action 'reply'    — the platform replies with `response_text` and
 *                          records an audit event (e.g. Reach Church PRAY);
 *      action 'dispatch' — the platform recognises the command, attributes it
 *                          to the owner the Phase 8 resolver established,
 *                          records a durable dispatch row
 *                          (keyword_command_dispatches) and emits a
 *                          tenant-scoped event the owning application's own
 *                          backend handles with its real business logic (e.g.
 *                          HaulPro WHERE IS MY DRIVER). The platform never
 *                          fabricates the business answer; `response_text`,
 *                          if set, is only an acknowledgement.
 *  - tenant_id NULL = an application-wide default for every tenant of the
 *    application (set by a platform operator); a tenant row with the same
 *    keyword overrides it (and `enabled = false` switches it off for that
 *    tenant only).
 *
 * Keys are the same loose text (app_id, tenant_id) convention as
 * messaging_profiles / consent_records / conversations (gap register D14).
 */
export const RESERVED_KEYWORDS = ['STOP', 'START', 'HELP', 'YES', 'NO'] as const;
export type ReservedKeyword = (typeof RESERVED_KEYWORDS)[number];
export const KEYWORD_COMMAND_ACTIONS = ['reply', 'dispatch'] as const;
export type KeywordCommandAction = (typeof KEYWORD_COMMAND_ACTIONS)[number];

export const keywordCommands = pgTable(
  'keyword_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: text('app_id').notNull(),
    // NULL = application-wide default (every tenant of app_id).
    tenantId: text('tenant_id'),
    // Canonical, normalised form: upper case, single spaces, no trailing
    // punctuation (see normalizeKeywordText in @company/routing).
    keyword: text('keyword').notNull(),
    aliases: jsonb('aliases').notNull().default(sql`'[]'::jsonb`),
    action: text('action').notNull(),
    responseText: text('response_text'),
    // Short description listed in the owner's HELP reply; NULL = not listed.
    helpText: text('help_text'),
    // dispatch only: workflow identifier recorded on the conversation and on
    // the dispatch event ("full pipeline through workflow resolution").
    workflowId: text('workflow_id'),
    enabled: boolean('enabled').notNull().default(true),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_keyword_commands_scope').on(t.appId, t.tenantId, t.keyword).nullsNotDistinct(),
    index('idx_keyword_commands_owner').on(t.appId, t.tenantId),
    check('chk_keyword_commands_action', sql`${t.action} IN ('reply', 'dispatch')`),
    check('chk_keyword_commands_keyword_normalized', sql`${t.keyword} = upper(btrim(${t.keyword})) AND ${t.keyword} <> ''`),
    // Reserved compliance keywords: wording override only — never a dispatch,
    // never a workflow.
    check(
      'chk_keyword_commands_reserved_wording_only',
      sql`${t.keyword} NOT IN ('STOP', 'START', 'HELP', 'YES', 'NO') OR (${t.action} = 'reply' AND ${t.workflowId} IS NULL)`,
    ),
    // An enabled 'reply' command must have something to reply with.
    check(
      'chk_keyword_commands_reply_text',
      sql`NOT ${t.enabled} OR ${t.action} <> 'reply' OR ${t.responseText} IS NOT NULL`,
    ),
  ],
);

/**
 * Phase 9 — one row per recognised app-specific 'dispatch' command: the
 * durable, tenant-scoped record the owning application consumes (pull:
 * GET /v1/api/gateway/keyword-dispatches; push: the tenant-scoped
 * 'keyword_command' event delivered to its webhook endpoints). Also the
 * audit trail of every app-specific command the platform recognised.
 *
 * dedupe_key makes a retried inbound job (or a webhook redelivery) record
 * the command once.
 */
export const KEYWORD_DISPATCH_STATUSES = ['pending', 'acknowledged'] as const;

export const keywordCommandDispatches = pgTable(
  'keyword_command_dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dedupeKey: text('dedupe_key').notNull(),
    appId: text('app_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    supplierId: text('supplier_id'),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    commandId: uuid('command_id').references(() => keywordCommands.id, { onDelete: 'set null' }),
    keyword: text('keyword').notNull(),
    argument: text('argument'),
    workflowId: text('workflow_id'),
    customerPhone: text('customer_phone').notNull(),
    businessNumber: text('business_number'),
    providerId: text('provider_id').notNull(),
    channel: text('channel').notNull().default('sms'),
    content: text('content').notNull(),
    // Set when the message reached its owner through an operator-resolved hold.
    holdId: uuid('hold_id'),
    status: text('status').notNull().default('pending'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_keyword_dispatches_dedupe_key').on(t.dedupeKey),
    index('idx_keyword_dispatches_owner_status').on(t.appId, t.tenantId, t.status),
    check('chk_keyword_dispatches_status', sql`${t.status} IN ('pending', 'acknowledged')`),
  ],
);

export type KeywordCommand = typeof keywordCommands.$inferSelect;
export type NewKeywordCommand = typeof keywordCommands.$inferInsert;
export type KeywordCommandDispatch = typeof keywordCommandDispatches.$inferSelect;
export type NewKeywordCommandDispatch = typeof keywordCommandDispatches.$inferInsert;
