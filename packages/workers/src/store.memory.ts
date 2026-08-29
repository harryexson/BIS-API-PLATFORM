import { KVStore } from './store';

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryStore implements KVStore {
  private kv = new Map<string, Entry>();
  private lists = new Map<string, string[]>();
  private zsets = new Map<string, Map<string, number>>();
  private locks = new Map<string, { owner: string; expiresAt: number }>();
  private subs = new Map<string, Set<(m: string) => void>>();

  private expired(key: string): boolean {
    const e = this.kv.get(key);
    if (!e) return true;
    if (e.expiresAt !== null && e.expiresAt < Date.now()) {
      this.kv.delete(key);
      return true;
    }
    return false;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.kv.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  async get(key: string): Promise<string | null> {
    if (this.expired(key)) return null;
    return this.kv.get(key)!.value;
  }

  async del(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (!this.expired(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const current = this.expired(key) ? 0 : Number(this.kv.get(key)!.value) || 0;
    const next = current + 1;
    await this.set(key, String(next), ttlMs);
    return next;
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    const e = this.kv.get(key);
    if (e) e.expiresAt = Date.now() + ttlMs;
  }

  async pttl(key: string): Promise<number> {
    const e = this.kv.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, e.expiresAt - Date.now());
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) || [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.shift()!;
  }

  async llen(key: string): Promise<number> {
    return (this.lists.get(key) || []).length;
  }

  async lrem(key: string, value: string): Promise<number> {
    const list = this.lists.get(key);
    if (!list) return 0;
    const before = list.length;
    this.lists.set(
      key,
      list.filter((v) => v !== value),
    );
    return before - this.lists.get(key)!.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || [];
    const s = start < 0 ? list.length + start : start;
    const e = stop < 0 ? list.length + stop : stop;
    return list.slice(s, e + 1);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.zsets.get(key) || new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.zsets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const set = this.zsets.get(key);
    if (!set) return [];
    return Array.from(set.entries())
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    return (this.zsets.get(key) || new Map()).size;
  }

  async acquireLock(resource: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(resource);
    if (existing) {
      if (existing.expiresAt <= Date.now()) {
        this.locks.delete(resource);
      } else if (existing.owner !== ownerId) {
        return false;
      }
    }
    this.locks.set(resource, { owner: ownerId, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async releaseLock(resource: string, ownerId: string): Promise<boolean> {
    const existing = this.locks.get(resource);
    if (!existing) return false;
    if (existing.owner !== ownerId) return false;
    if (existing.expiresAt <= Date.now()) return false;
    this.locks.delete(resource);
    return true;
  }

  async publish(channel: string, message: string): Promise<number> {
    const handlers = this.subs.get(channel);
    if (!handlers) return 0;
    handlers.forEach((h) => h(message));
    return handlers.size;
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => void> {
    if (!this.subs.has(channel)) this.subs.set(channel, new Set());
    this.subs.get(channel)!.add(handler);
    return () => {
      const handlers = this.subs.get(channel);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) this.subs.delete(channel);
      }
    };
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.kv.keys()).filter((k) => regex.test(k));
  }
}
