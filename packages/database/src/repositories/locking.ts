import { sql, type Column, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * `<col> = ANY(ARRAY(<locking sub-select>))` — how every claim/lease/rescue in this package feeds a
 * `LIMIT n FOR UPDATE SKIP LOCKED` candidate set into an UPDATE.
 *
 * The obvious `<col> IN (<sub-select>)` is NOT safe: Postgres may plan it as
 * a Nested Loop Semi Join that RE-SCANS the sub-select once per outer row,
 * and each rescan's LockRows skips the rows the same statement has already
 * locked/updated and takes the next ones — so `LIMIT 10` claims 20, 30, ...
 * rows. Observed on outbox_events (real Postgres 16, a fresh table with
 * 10 of 30 rows locked by another transaction: `Nested Loop Semi Join`,
 * sub-select `loops=30`, 20 rows claimed by a LIMIT 10 — see
 * outbox.postgres.integration.test.ts "SKIP LOCKED"). An uncorrelated
 * ARRAY(sub-select) is an InitPlan, which Postgres evaluates exactly once.
 */
export function inLockedCandidates(col: Column | SQL, candidates: SQLWrapper): SQL {
  return sql`${col} = ANY(ARRAY(${candidates}))`;
}
