import { KVStore } from './store';
import { Keys } from './keys';

export interface IdempotencyRecord {
  status: 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  updatedAt: number;
  /**
   * B6: id of the job whose attempt took this claim. Lets the stale-job
   * reaper tell "this job's own crashed attempt is still holding the claim"
   * (release it, the job must run again) apart from "another job with the
   * same key holds it" (leave it alone). Absent on claims written before
   * Phase 13.
   */
  ownerJobId?: string;
}

export class IdempotencyStore {
  constructor(
    private store: KVStore,
    private keys: Keys,
    private ttlMs: number,
  ) {}

  async claim(key: string, ownerJobId?: string): Promise<'new' | 'processing' | 'completed' | 'failed'> {
    const existing = await this.store.get(this.keys.idempotency(key));
    if (existing) {
      const rec = JSON.parse(existing) as IdempotencyRecord;
      return rec.status;
    }
    // P1: Use setNx for atomic claim — prevents race condition where two
    // workers both read 'no existing record' and both proceed to claim.
    const rec: IdempotencyRecord = {
      status: 'processing',
      updatedAt: Date.now(),
      ...(ownerJobId ? { ownerJobId } : {}),
    };
    const claimed = await this.store.setNx(
      this.keys.idempotency(key),
      JSON.stringify(rec),
      this.ttlMs,
    );
    if (!claimed) {
      // Another worker claimed it between our get and setNx — re-read
      const late = await this.store.get(this.keys.idempotency(key));
      if (late) {
        return (JSON.parse(late) as IdempotencyRecord).status;
      }
      return 'processing';
    }
    return 'new';
  }

  async complete(key: string, result: any): Promise<void> {
    const rec: IdempotencyRecord = {
      status: 'completed',
      result,
      updatedAt: Date.now(),
    };
    await this.store.set(this.keys.idempotency(key), JSON.stringify(rec), this.ttlMs);
  }

  async fail(key: string, error: string): Promise<void> {
    const rec: IdempotencyRecord = {
      status: 'failed',
      error,
      updatedAt: Date.now(),
    };
    await this.store.set(this.keys.idempotency(key), JSON.stringify(rec), this.ttlMs);
  }

  async release(key: string): Promise<void> {
    await this.store.del(this.keys.idempotency(key));
  }

  /**
   * B6 FIX: releases a claim abandoned by a crashed attempt of `jobId`.
   * Called by the stale-job reaper when it rescues that job. Without this,
   * the rescued job's next attempt found its own dead attempt's claim still
   * `processing` (24h TTL, never released by the crash) and was marked
   * `completed` having run zero times (probe2-B).
   *
   * Only a `processing` claim owned by this exact job is released — a claim
   * held by a different job sharing the key, or one already `completed`, is
   * left untouched. Returns true if a claim was released.
   */
  async releaseAbandonedClaim(key: string, jobId: string): Promise<boolean> {
    const raw = await this.store.get(this.keys.idempotency(key));
    if (!raw) return false;
    const rec = JSON.parse(raw) as IdempotencyRecord;
    if (rec.status !== 'processing' || rec.ownerJobId !== jobId) return false;
    await this.store.del(this.keys.idempotency(key));
    return true;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.store.get(this.keys.idempotency(key));
    return raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
  }
}
