import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  keywordCommands,
  keywordCommandDispatches,
  type KeywordCommand,
  type KeywordCommandDispatch,
} from '../schema';
import { normalizeMessagingAddress } from '../messaging-address';
import {
  validateKeywordCommand,
  mergeEffectiveKeywordCommands,
  findPhraseConflict,
  normalizeKeywordText,
  KeywordCommandValidationError,
  type KeywordCommandInput,
} from '../keyword-grammar';

/**
 * Phase 9 (gap register A13) — keyword_commands: per-application and
 * per-tenant keyword configuration. See schema/keyword-commands.ts.
 *
 * `tenantId: null` addresses the APPLICATION-WIDE scope (operator-managed
 * defaults for every tenant of the application); a string addresses that one
 * tenant's own overrides. Callers that act for a tenant (the gateway's
 * tenant-authenticated routes) must only ever pass the VERIFIED tenant id.
 */
export const keywordCommandRepository = {
  /** Every row (enabled or not) in exactly one scope. */
  async listForScope(appId: string, tenantId: string | null): Promise<KeywordCommand[]> {
    const db = getDb();
    return db
      .select()
      .from(keywordCommands)
      .where(and(eq(keywordCommands.appId, appId), tenantId === null ? isNull(keywordCommands.tenantId) : eq(keywordCommands.tenantId, tenantId)))
      .orderBy(asc(keywordCommands.keyword));
  },

  /**
   * The ENABLED commands in force for one owner: app-wide rows overlaid by
   * the tenant's own rows. This is what the inbound pipeline matches
   * against. A lookup error propagates (the inbound job retries) — it is
   * never treated as "no commands configured".
   */
  async findEffectiveForOwner(appId: string, tenantId: string): Promise<KeywordCommand[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(keywordCommands)
      .where(and(eq(keywordCommands.appId, appId), or(isNull(keywordCommands.tenantId), eq(keywordCommands.tenantId, tenantId))));
    return mergeEffectiveKeywordCommands(rows, tenantId);
  },

  /**
   * Create or replace one command in a scope. Validated (keyword grammar,
   * reserved-keyword rules, no phrase claimed twice for the same owner)
   * before a single INSERT ... ON CONFLICT statement.
   */
  async upsert(
    appId: string,
    tenantId: string | null,
    input: KeywordCommandInput,
    updatedBy: string,
  ): Promise<KeywordCommand> {
    const valid = validateKeywordCommand(input);
    const db = getDb();
    const inForce = tenantId === null
      ? (await this.listForScope(appId, null)).filter((r) => r.enabled)
      : await this.findEffectiveForOwner(appId, tenantId);
    const conflict = findPhraseConflict(valid, inForce);
    if (conflict) {
      throw new KeywordCommandValidationError(
        'aliases',
        `"${conflict.phrase}" is already recognised as the ${conflict.claimedBy} command for this owner`,
      );
    }
    const now = new Date();
    const values = {
      appId,
      tenantId,
      keyword: valid.keyword,
      aliases: valid.aliases,
      action: valid.action,
      responseText: valid.responseText,
      helpText: valid.helpText,
      workflowId: valid.workflowId,
      enabled: valid.enabled,
      updatedBy,
    };
    const rows = await db
      .insert(keywordCommands)
      .values(values)
      .onConflictDoUpdate({
        target: [keywordCommands.appId, keywordCommands.tenantId, keywordCommands.keyword],
        set: {
          aliases: valid.aliases,
          action: valid.action,
          responseText: valid.responseText,
          helpText: valid.helpText,
          workflowId: valid.workflowId,
          enabled: valid.enabled,
          updatedBy,
          updatedAt: now,
        },
      })
      .returning();
    if (!rows[0]) throw new Error(`keyword command ${valid.keyword} was not persisted`);
    return rows[0];
  },

  async remove(appId: string, tenantId: string | null, keyword: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(keywordCommands)
      .where(
        and(
          eq(keywordCommands.appId, appId),
          tenantId === null ? isNull(keywordCommands.tenantId) : eq(keywordCommands.tenantId, tenantId),
          eq(keywordCommands.keyword, normalizeKeywordText(keyword)),
        ),
      )
      .returning({ id: keywordCommands.id });
    return rows.length > 0;
  },
};

export interface KeywordDispatchInput {
  dedupeKey: string;
  appId: string;
  tenantId: string;
  supplierId: string | null;
  conversationId: string | null;
  commandId: string | null;
  keyword: string;
  argument: string | null;
  workflowId: string | null;
  customerPhone: string;
  businessNumber: string | null;
  providerId: string;
  channel: string;
  content: string;
  holdId: string | null;
}

export const keywordCommandDispatchRepository = {
  /**
   * Record a recognised app-specific command for its owner. Idempotent on
   * dedupeKey (a retried inbound job / redelivered webhook gets the SAME row,
   * created: false). Confirmed with a read (PHASE5-01/02) before returning.
   */
  async recordOnce(data: KeywordDispatchInput): Promise<{ dispatch: KeywordCommandDispatch; created: boolean }> {
    const db = getDb();
    const inserted = await db
      .insert(keywordCommandDispatches)
      .values({
        ...data,
        customerPhone: normalizeMessagingAddress(data.customerPhone),
        businessNumber: data.businessNumber ? normalizeMessagingAddress(data.businessNumber) : null,
      })
      .onConflictDoNothing({ target: keywordCommandDispatches.dedupeKey })
      .returning();
    const rows = await db
      .select()
      .from(keywordCommandDispatches)
      .where(eq(keywordCommandDispatches.dedupeKey, data.dedupeKey))
      .limit(1);
    if (!rows[0]) throw new Error(`keyword dispatch ${data.dedupeKey} was not persisted`);
    return { dispatch: rows[0], created: Boolean(inserted[0]) };
  },

  /** One owner's dispatches, newest first. Never crosses (app, tenant). */
  async listForOwner(
    appId: string,
    tenantId: string,
    opts: { status?: string; supplierId?: string | null; limit?: number } = {},
  ): Promise<KeywordCommandDispatch[]> {
    const db = getDb();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const conditions = [eq(keywordCommandDispatches.appId, appId), eq(keywordCommandDispatches.tenantId, tenantId)];
    if (opts.status) conditions.push(eq(keywordCommandDispatches.status, opts.status));
    if (opts.supplierId) conditions.push(eq(keywordCommandDispatches.supplierId, opts.supplierId));
    return db
      .select()
      .from(keywordCommandDispatches)
      .where(and(...conditions))
      .orderBy(desc(keywordCommandDispatches.createdAt))
      .limit(limit);
  },

  /** pending → acknowledged, by its owner only (single conditional UPDATE). */
  async acknowledge(
    id: string,
    owner: { appId: string; tenantId: string; supplierId?: string | null },
  ): Promise<KeywordCommandDispatch | undefined> {
    const db = getDb();
    const conditions = [
      eq(keywordCommandDispatches.id, id),
      eq(keywordCommandDispatches.appId, owner.appId),
      eq(keywordCommandDispatches.tenantId, owner.tenantId),
      eq(keywordCommandDispatches.status, 'pending'),
    ];
    if (owner.supplierId) conditions.push(eq(keywordCommandDispatches.supplierId, owner.supplierId));
    const rows = await db
      .update(keywordCommandDispatches)
      .set({ status: 'acknowledged', acknowledgedAt: sql`now()` })
      .where(and(...conditions))
      .returning();
    return rows[0];
  },
};
