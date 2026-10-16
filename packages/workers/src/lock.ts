import { KVStore } from './store';
import { Keys } from './keys';

/**
 * Thrown by DistributedLock.withLock() when the lock is still held by
 * someone else after the bounded wait. A job processor that lets this
 * propagate gets the normal queue retry with backoff; callers that would
 * rather skip use tryWithLock(), which never throws on contention.
 */
export class LockNotAcquiredError extends Error {
  constructor(public readonly resource: string, public readonly waitedMs: number) {
    super(`Unable to acquire distributed lock for resource "${resource}" (still held after waiting ${waitedMs}ms)`);
    this.name = 'LockNotAcquiredError';
  }
}

export interface LockWaitOptions {
  /** Total time to keep retrying while the lock is held elsewhere. 0 = a single attempt. */
  waitMs?: number;
  /** First retry delay; doubles on each retry up to maxRetryDelayMs. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export type LockOutcome<T> = { acquired: true; value: T } | { acquired: false };

/** Default bounded wait for withLock(). Locks in this codebase guard short critical sections (a provider status update, one health probe + DB write). */
export const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_MAX_RETRY_DELAY_MS = 500;

export class DistributedLock {
  constructor(
    private store: KVStore,
    private keys: Keys,
  ) {}

  async acquire(resource: string, ownerId: string, ttlMs: number): Promise<boolean> {
    return this.store.acquireLock(this.keys.lock(resource), ownerId, ttlMs);
  }

  async release(resource: string, ownerId: string): Promise<boolean> {
    return this.store.releaseLock(this.keys.lock(resource), ownerId);
  }

  /**
   * B15 FIX: acquire, retrying with bounded exponential backoff while the
   * lock is held elsewhere. Resolves false once `waitMs` has passed without
   * acquiring; it never throws because of contention (store errors still
   * propagate).
   */
  async acquireWithWait(resource: string, ownerId: string, ttlMs: number, opts: LockWaitOptions = {}): Promise<boolean> {
    const waitMs = Math.max(0, opts.waitMs ?? 0);
    const maxDelay = Math.max(1, opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
    let delay = Math.max(1, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await this.acquire(resource, ownerId, ttlMs)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /**
   * B15 FIX: run `fn` under the lock if it can be acquired within
   * `opts.waitMs` (default: one attempt, no wait); otherwise skip `fn` and
   * resolve `{ acquired: false }`. For work where "someone else is already
   * doing this right now" means there is nothing to do (a singleton sweep,
   * a duplicate health probe).
   */
  async tryWithLock<T>(
    resource: string,
    ownerId: string,
    ttlMs: number,
    fn: () => Promise<T>,
    opts: LockWaitOptions = {},
  ): Promise<LockOutcome<T>> {
    if (!(await this.acquireWithWait(resource, ownerId, ttlMs, opts))) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await this.release(resource, ownerId).catch(() => undefined);
    }
  }

  /**
   * Run `fn` under the lock. B15 FIX: contention no longer throws
   * immediately. It waits with bounded backoff (default
   * DEFAULT_LOCK_WAIT_MS) and throws LockNotAcquiredError only if the lock
   * is still held after that, so a job processor gets the queue's normal
   * retry. For work that must not be skipped (e.g. applying a provider
   * webhook's status update).
   */
  async withLock<T>(
    resource: string,
    ownerId: string,
    ttlMs: number,
    fn: () => Promise<T>,
    opts: LockWaitOptions = {},
  ): Promise<T> {
    const waitMs = opts.waitMs ?? DEFAULT_LOCK_WAIT_MS;
    const outcome = await this.tryWithLock(resource, ownerId, ttlMs, fn, { ...opts, waitMs });
    if (!outcome.acquired) throw new LockNotAcquiredError(resource, waitMs);
    return outcome.value;
  }
}
