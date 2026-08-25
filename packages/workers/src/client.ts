import { KVStore } from './store';
import { MemoryStore } from './store.memory';
import { RedisStore } from './store.redis';

export async function createStore(redisUrl?: string): Promise<KVStore> {
  const url = redisUrl || process.env.REDIS_URL;

  if (!url || url === 'memory') {
    return new MemoryStore();
  }

  const store = new RedisStore(url);
  try {
    await store.ping();
    return store;
  } catch (err) {
    console.warn(
      '[workers] Redis unavailable, falling back to in-memory store (ephemeral). ' +
        'Redis is required for production durability.',
    );
    await store.quit?.();
    return new MemoryStore();
  }
}

export { MemoryStore } from './store.memory';
export { RedisStore } from './store.redis';
export type { KVStore } from './store';
