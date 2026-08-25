import { KVStore } from './store';
import { Keys } from './keys';

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

  async withLock<T>(
    resource: string,
    ownerId: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const acquired = await this.acquire(resource, ownerId, ttlMs);
    if (!acquired) {
      throw new Error(`Unable to acquire distributed lock for resource "${resource}"`);
    }
    try {
      return await fn();
    } finally {
      await this.release(resource, ownerId).catch(() => undefined);
    }
  }
}
