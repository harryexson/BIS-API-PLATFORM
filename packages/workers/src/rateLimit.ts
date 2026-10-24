import { KVStore } from './store';
import { Keys } from './keys';
import { RateLimitConfig } from './types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
}

export class RateLimiter {
  constructor(
    private store: KVStore,
    private keys: Keys,
    private config: RateLimitConfig,
  ) {}

  async limit(scope: string, weight = 1): Promise<RateLimitResult> {
    const key = this.keys.rateLimit(scope);
    // B14 FIX: incr() arms the TTL only when it creates the key (atomically
    // in Redis), so this is a fixed window that closes on schedule however
    // hard callers keep retrying. The extra expire() that used to follow on
    // count === 1 is gone: it was a second, non-atomic write of the same TTL.
    const count = await this.store.incr(key, this.config.windowMs);

    const limit = this.config.maxRequests;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const resetMs = allowed ? await this.store.pttl(key) : 0;

    if (!allowed) {
      return { allowed: false, remaining: 0, resetMs, limit };
    }

    return { allowed: true, remaining: remaining - weight, resetMs, limit };
  }

  async reset(scope: string): Promise<void> {
    await this.store.del(this.keys.rateLimit(scope));
  }
}
