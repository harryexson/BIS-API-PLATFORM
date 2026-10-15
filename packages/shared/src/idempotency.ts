import { createHash } from 'node:crypto';
import { idempotencyRecordRepository } from '@company/database';

/**
 * The subset of the database repository the service needs. Injectable so the
 * service can be bound to a real Postgres in tests (see
 * packages/database/src/idempotency.postgres.integration.test.ts).
 */
export interface IdempotencyStore {
  claim(input: {
    appId: string;
    tenantId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    ttlMs: number;
  }): Promise<
    | { claimed: true; record: { id: string } }
    | { claimed: false; existing: { id: string; status: string; requestHash: string; result: unknown } | undefined }
  >;
  complete(id: string, result: unknown): Promise<boolean | void>;
  fail(id: string, error: string): Promise<boolean | void>;
}

export type IdempotencyOutcome =
  /** Caller owns the key and must run the operation, then complete()/fail(). */
  | 'claimed'
  /** Same key + same request already completed — return `existingResult`. */
  | 'replay'
  /** Same key + same request still running elsewhere (after waiting, if asked). */
  | 'in_progress'
  /** Same key, DIFFERENT request — must be rejected, never processed. */
  | 'conflict';

export interface IdempotencyClaim {
  outcome: IdempotencyOutcome;
  /** Kept for existing callers: true only when outcome === 'claimed'. */
  claimed: boolean;
  recordId?: string;
  /** Stored result: set for 'replay', and for 'conflict' when the original completed. */
  existingResult?: any;
}

export interface CheckAndClaimOptions {
  /** Claim lifetime. Default 5 minutes. */
  ttlMs?: number;
  /**
   * If the key is held by an in-flight request with the SAME request hash,
   * wait up to this long for it to finish and return its result (so a
   * double-submit gets the same answer instead of a 409). 0 = don't wait.
   */
  waitForInFlightMs?: number;
  /** Poll interval while waiting. Default 100ms. */
  pollIntervalMs?: number;
}

const DEFAULT_TTL_MS = 300_000;
// Bounded retries for the narrow race where the row changes between the
// claim statement and the follow-up read (e.g. it expired or failed in
// between). Exhausting them answers 'in_progress' — the safe answer, since
// it never runs the operation.
const MAX_RACE_RETRIES = 5;

/**
 * Deterministic SHA-256 hex fingerprint of a request's mutating fields.
 * Object keys are sorted recursively so property order never matters;
 * `undefined` members are dropped (same as JSON.stringify). Values are NOT
 * coerced: amount `25` and amount `"25"` hash differently, which errs on the
 * side of rejecting rather than double-processing.
 */
export function computeRequestHash(fields: unknown): string {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Platform-level idempotency service, backed by the database.
 *
 * Uniqueness of (app_id, tenant_id, operation, idempotency_key) is enforced by
 * the idx_idempotency_composite unique index, and claiming is a single atomic
 * INSERT ... ON CONFLICT DO UPDATE ... WHERE statement
 * (idempotencyRecordRepository.claim). The request_hash stored on the row
 * decides same-request (replay/wait) vs different-request (conflict).
 *
 * Provider-specific idempotency (e.g., Stripe's Idempotency-Key header)
 * is an additional internal layer on top of this.
 *
 * Errors from the store (DB down, etc.) PROPAGATE. Callers must treat them
 * as "could not guarantee idempotency" and refuse the operation (fail
 * closed) — they are never swallowed here.
 */
export class PlatformIdempotencyService {
  constructor(private readonly store: IdempotencyStore = idempotencyRecordRepository) {}

  async checkAndClaim(
    appId: string,
    tenantId: string,
    operation: string,
    idempotencyKey: string,
    requestHash: string,
    options: CheckAndClaimOptions = {},
  ): Promise<IdempotencyClaim> {
    if (!requestHash) {
      throw new Error('PlatformIdempotencyService.checkAndClaim: requestHash is required');
    }
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const waitMs = Math.max(0, options.waitForInFlightMs ?? 0);
    const pollMs = Math.max(10, options.pollIntervalMs ?? 100);
    const deadline = Date.now() + waitMs;
    let raceRetries = 0;

    for (;;) {
      const res = await this.store.claim({ appId, tenantId, operation, idempotencyKey, requestHash, ttlMs });
      if (res.claimed) {
        return { outcome: 'claimed', claimed: true, recordId: res.record.id };
      }

      const existing = res.existing;
      if (existing) {
        // '' = legacy row from before request hashes were stored; unknown,
        // so it is not treated as a mismatch here (callers may still compare
        // a fingerprint kept inside `result`).
        if (existing.requestHash && existing.requestHash !== requestHash) {
          return {
            outcome: 'conflict',
            claimed: false,
            existingResult: existing.status === 'completed' ? existing.result : undefined,
          };
        }
        if (existing.status === 'completed') {
          return { outcome: 'replay', claimed: false, existingResult: existing.result };
        }
        if (existing.status === 'processing') {
          if (Date.now() < deadline) {
            await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
            continue;
          }
          return { outcome: 'in_progress', claimed: false, existingResult: null };
        }
      }

      // Row vanished, or became re-claimable (expired / failed) between the
      // claim and the read: just try to claim again.
      if (raceRetries++ < MAX_RACE_RETRIES) continue;
      return { outcome: 'in_progress', claimed: false, existingResult: null };
    }
  }

  /**
   * Mark the record completed with the result. Returns false when this
   * caller no longer owns the claim (it expired and was re-claimed).
   */
  async complete(recordId: string, result: any): Promise<boolean> {
    return (await this.store.complete(recordId, result)) !== false;
  }

  /** Mark the record failed (re-claimable by the same request). */
  async fail(recordId: string, error: string): Promise<boolean> {
    return (await this.store.fail(recordId, error)) !== false;
  }
}
