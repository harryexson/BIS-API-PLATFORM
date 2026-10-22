import { sql, type AnyColumn } from 'drizzle-orm';
import { check } from 'drizzle-orm/pg-core';

/**
 * Phase 16 (gap register D14): the free-text `tenant_id` columns (every
 * table below except users / tenant_application_links, which hold a real
 * UUID FK to tenants.id) had no constraint at all, so an empty or
 * whitespace-only tenant id was storable and silently formed its own
 * "tenant". This CHECK rejects that one clearly-invalid shape. NULL still
 * passes (a CHECK is only violated by FALSE), so the columns that are
 * deliberately nullable — events, keyword_commands (NULL = app-wide
 * default), webhook_events (unattributed provider webhook) — keep their
 * meaning.
 *
 * It is NOT a foreign key: these columns are not typed/FK'd consistently
 * across the schema (see the Phase 16 report), and converting them is a
 * larger migration deliberately left to a later phase.
 *
 * Migration 0021 adds each constraint NOT VALID and validates it only when
 * the table holds no blank tenant ids, so the migration can never fail on
 * legacy data; new writes are checked either way.
 */
export function tenantIdNonBlank(table: string, column: AnyColumn) {
  return check(`chk_${table}_tenant_id_nonblank`, sql`btrim(${column}) <> ''`);
}
