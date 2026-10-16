export interface KVStore {
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /**
   * Increment a counter. `ttlMs` is applied only when this call creates the
   * key (or the key has no expiry): a fixed window, never re-armed by later
   * increments (gap register B14).
   */
  incr(key: string, ttlMs?: number): Promise<number>;
  expire(key: string, ttlMs: number): Promise<void>;
  pttl(key: string): Promise<number>;

  rpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  lrem(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;

  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
  zcard(key: string): Promise<number>;

  acquireLock(resource: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseLock(resource: string, ownerId: string): Promise<boolean>;

  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;

  keys?(pattern: string): Promise<string[]>;
  ping?(): Promise<void>;
  quit?(): Promise<void>;
}
