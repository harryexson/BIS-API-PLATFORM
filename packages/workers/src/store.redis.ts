import Redis from 'ioredis';
import { KVStore } from './store';

const UNLOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

/**
 * Redis-backed KVStore with automatic reconnection and exponential backoff.
 *
 * On connection loss, the client retries with increasing delays (500ms → 1s → 2s
 * → ... → 30s cap). Operations fail with descriptive errors during reconnection
 * rather than hanging indefinitely.
 */
export class RedisStore implements KVStore {
  private client: Redis;
  private subClient: Redis;
  private channels = new Map<string, Set<(m: string) => void>>();
  private connected = false;
  private reconnectAttempts = 0;

  constructor(url: string) {
    const baseOpts: Redis.RedisOptions = {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy(times: number) {
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, times - 1), RECONNECT_MAX_MS);
        return delay;
      },
      // Enable health checks every 30s
      enableReadyCheck: true,
      // Auto-resend commands after reconnection
      autoResendUnfulfilledCommands: true,
      // Reconnect on all error types
      reconnectOnError(err) {
        const targetError = 'READONLY';
        return err.message.includes(targetError);
      },
    };

    this.client = new Redis(url, baseOpts);
    this.subClient = new Redis(url, { ...baseOpts, maxRetriesPerRequest: 3 });

    this.subClient.on('message', (channel: string, message: string) => {
      this.channels.get(channel)?.forEach((h) => h(message));
    });

    // Track connection state
    this.client.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
    });

    this.client.on('error', () => {
      this.connected = false;
      this.reconnectAttempts++;
    });

    this.client.on('close', () => {
      this.connected = false;
    });

    // Connect lazily
    this.client.connect().catch(() => undefined);
    this.subClient.connect().catch(() => undefined);
  }

  /**
   * Returns true if the Redis client is currently connected and ready.
   */
  isConnected(): boolean {
    return this.connected && this.client.status === 'ready';
  }

  /**
   * Returns the number of reconnection attempts since last successful connection.
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  private assertConnected(): void {
    if (!this.isConnected()) {
      throw new Error(
        `Redis not connected (status: ${this.client.status}, reconnects: ${this.reconnectAttempts})`,
      );
    }
  }

  async ping(): Promise<void> {
    this.assertConnected();
    await this.client.ping();
  }

  async quit(): Promise<void> {
    this.connected = false;
    await this.client.quit().catch(() => undefined);
    await this.subClient.quit().catch(() => undefined);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.assertConnected();
    if (ttlMs) await this.client.set(key, value, 'PX', ttlMs);
    else await this.client.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    this.assertConnected();
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    this.assertConnected();
    await this.client.del(key);
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.assertConnected();
    const res = await this.client.set(key, value, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    this.assertConnected();
    const value = await this.client.incr(key);
    if (ttlMs) await this.client.pexpire(key, ttlMs);
    return value;
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    this.assertConnected();
    await this.client.pexpire(key, ttlMs);
  }

  async pttl(key: string): Promise<number> {
    this.assertConnected();
    return this.client.pttl(key);
  }

  async rpush(key: string, value: string): Promise<number> {
    this.assertConnected();
    return this.client.rpush(key, value);
  }

  async lpop(key: string): Promise<string | null> {
    this.assertConnected();
    return this.client.lpop(key);
  }

  async llen(key: string): Promise<number> {
    this.assertConnected();
    return this.client.llen(key);
  }

  async lrem(key: string, value: string): Promise<number> {
    this.assertConnected();
    return this.client.lrem(key, 0, value);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.assertConnected();
    return this.client.lrange(key, start, stop);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.assertConnected();
    return this.client.zadd(key, score, member);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    this.assertConnected();
    return this.client.zrangebyscore(key, min, max);
  }

  async zrem(key: string, member: string): Promise<number> {
    this.assertConnected();
    return this.client.zrem(key, member);
  }

  async zcard(key: string): Promise<number> {
    this.assertConnected();
    return this.client.zcard(key);
  }

  async acquireLock(resource: string, ownerId: string, ttlMs: number): Promise<boolean> {
    this.assertConnected();
    const res = await this.client.set(resource, ownerId, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async releaseLock(resource: string, ownerId: string): Promise<boolean> {
    this.assertConnected();
    const res = await this.client.eval(UNLOCK_LUA, 1, resource, ownerId);
    return res === 1;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.assertConnected();
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

  async keys(pattern: string): Promise<string[]> {
    this.assertConnected();
    const result: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      result.push(...keys);
    } while (cursor !== '0');
    return result;
  }
}
