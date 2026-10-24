import Redis, { type RedisOptions } from 'ioredis';
import { KVStore } from './store';

const UNLOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

// B14 FIX: fixed-window counter. INCR, and set the expiry ONLY when this
// call created the key (result 1) — or when the key somehow has no expiry at
// all (PTTL -1, e.g. left behind by a pre-fix INCR whose PEXPIRE never ran),
// so a counter can never become a permanent block. One script = one atomic
// step on the server, so concurrent first-increments from different
// processes cannot each re-arm the window.
const INCR_FIXED_WINDOW_LUA = `
local v = redis.call('incr', KEYS[1])
if v == 1 or redis.call('pttl', KEYS[1]) == -1 then
  redis.call('pexpire', KEYS[1], ARGV[1])
end
return v
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
  private initialConnect: Promise<{ ok: true } | { ok: false; err: unknown }>;

  constructor(url: string) {
    const baseOpts: RedisOptions = {
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
      reconnectOnError(err: Error) {
        const targetError = 'READONLY';
        return err.message.includes(targetError);
      },
    };

    this.client = new Redis(url, baseOpts);
    this.subClient = new Redis(url, { ...baseOpts, maxRetriesPerRequest: 3 });

    this.subClient.on('message', (channel: string, message: string) => {
      this.channels.get(channel)?.forEach((h) => h(message));
    });

    // Track connection state. 'ready' (not 'connect') is the event that
    // means commands can actually be sent: with enableReadyCheck the socket
    // is open at 'connect' but ioredis still runs its INFO check first, and
    // isConnected() below requires status === 'ready' anyway.
    this.client.on('ready', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
    });

    this.client.on('error', () => {
      this.connected = false;
      this.reconnectAttempts++;
    });
    // Without a listener ioredis prints "[ioredis] Unhandled error event"
    // for every failed reconnect of the subscriber connection.
    this.subClient.on('error', () => undefined);

    this.client.on('close', () => {
      this.connected = false;
    });

    // B1 FIX: start connecting immediately, but KEEP the promise so
    // callers (createStore) can actually wait for the outcome. Previously
    // this was `this.client.connect().catch(() => undefined)` — fire and
    // forget — and createStore() probed the connection synchronously right
    // after construction, before the TCP handshake could possibly have
    // completed, so it fell back to MemoryStore on every single call even
    // with Redis up. The rejection is observed here (so it is never an
    // unhandled rejection) and re-surfaced through waitUntilReady().
    const connecting = Promise.all([this.client.connect(), this.subClient.connect()]).then(() => undefined);
    this.initialConnect = connecting.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  }

  /**
   * Resolves once BOTH connections (commands + pub/sub) are ready; rejects if
   * the initial connection attempt failed or did not finish within
   * `timeoutMs`. ioredis keeps reconnecting in the background after a
   * failed first attempt — callers that give up on this store should
   * quit() it to stop that.
   */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ ok: false; err: unknown }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, err: new Error(`Redis connection not ready within ${timeoutMs}ms (status: ${this.client.status})`) }),
        timeoutMs,
      );
    });
    try {
      const outcome = await Promise.race([this.initialConnect, timeout]);
      if (!outcome.ok) throw outcome.err instanceof Error ? outcome.err : new Error(String(outcome.err));
      // 'ready' handler may not have run yet if connect() resolved in the
      // same tick; the status check is authoritative.
      if (this.client.status === 'ready') this.connected = true;
      this.assertConnected();
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    // quit() needs a live connection to send QUIT; on a store that never
    // connected (or is mid-reconnect) it can hang/reject, so fall back to a
    // hard disconnect, which also stops the background reconnect loop.
    for (const c of [this.client, this.subClient]) {
      if (c.status === 'ready') await c.quit().catch(() => c.disconnect());
      else c.disconnect();
    }
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
    if (!ttlMs) return this.client.incr(key);
    const value = await this.client.eval(INCR_FIXED_WINDOW_LUA, 1, key, String(ttlMs));
    return Number(value);
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
