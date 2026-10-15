/**
 * Outbox consumer retry / staleness policy (gap register D10, Phase 5).
 *
 * No database dependency on purpose (same reasoning as transaction-status.ts):
 * repositories/outbox-events.ts re-exports these, and the simulation's
 * in-memory database double (packages/simulation/src/db.ts), which stands in
 * for '@company/database' under vi.mock, imports this file directly so the
 * worker code that does arithmetic with these values (outboxPoller.ts) sees
 * the exact same numbers in tests as in production.
 */
export interface OutboxRetryPolicy {
  /** Claims allowed before the row goes `dead` (a crash counts as a claim). */
  maxAttempts: number;
  /** Backoff after the Nth failed attempt: min(baseDelayMs * 2^(N-1), maxDelayMs). */
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};

/** A processing row whose claim is older than this is treated as abandoned (its worker died). */
export const DEFAULT_OUTBOX_STALE_AFTER_MS = 5 * 60_000;
