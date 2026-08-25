import Redis from 'ioredis';
import { KVStore } from './store';

const UNLOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export class RedisStore implements KVStore {
  private client: Redis;
  private subClient: Redis;
  private channels = new Map<string, Set<(m: string) => void>>();

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: 3 });
    this.subClient = new Redis(url, { maxRetriesPerRequest: 3 });
    this.subClient.on('message', (channel, message) => {
      this.channels.get(channel)?.forEach((h) => h(message));
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async quit(): Promise<void> {
    await this.client.quit();
    await this.subClient.quit();
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (ttlMs) await this.client.set(key, value, 'PX', ttlMs);
    else await this.client.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.set(key, value, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const value = await this.client.incr(key);
    if (ttlMs) await this.client.pexpire(key, ttlMs);
    return value;
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    await this.client.pexpire(key, ttlMs);
  }

  async pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }

  async rpush(key: string, value: string): Promise<number> {
    return this.client.rpush(key, value);
  }

  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async lrem(key: string, value: string): Promise<number> {
    return this.client.lrem(key, 0, value);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score, member);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max);
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async acquireLock(resource: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.set(resource, ownerId, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async releaseLock(resource: string, ownerId: string): Promise<boolean> {
    const res = await this.client.eval(UNLOCK_LUA, 1, resource, ownerId);
    return res === 1;
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
      await this.subClient.subscribe(channel);
    }
    this.channels.get(channel)!.add(handler);
    return () => {
      const handlers = this.channels.get(channel);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.channels.delete(channel);
        this.subClient.unsubscribe(channel).catch(() => undefined);
      }
    };
  }
}
