import { logger } from '@company/observability';
import { KVStore } from './store';
import { MemoryStore } from './store.memory';
import { RedisStore } from './store.redis';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface CreateStoreOptions {
  /** How long to wait for the initial Redis connection before falling back. */
  connectTimeoutMs?: number;
  /** Where the fallback warning goes (defaults to a structured logger.warn). */
  warn?: (message: string) => void;
}

/** Strip credentials from a Redis URL before it is logged. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return '<unparseable REDIS_URL>';
  }
}

/**
 * Returns a RedisStore when Redis is reachable, MemoryStore otherwise.
 *
 * B1 FIX: the connection is now actually AWAITED (bounded by
 * `connectTimeoutMs`, default 5s, env REDIS_CONNECT_TIMEOUT_MS) before the
 * readiness probe runs. Previously RedisStore's constructor fired connect()
 * without awaiting it and this function pinged synchronously right after,
 * so the probe failed before the TCP handshake could complete and EVERY
 * call fell back to MemoryStore — Redis up or down — which partitioned the
 * gateway and the worker into two private in-memory queues.
 *
 * The fallback itself is unchanged (an explicit 'memory' URL, or a Redis
 * that genuinely cannot be reached), but it is now a loud, specific warning
 * naming the URL and the reason, and only happens when Redis really is down.
 */
export async function createStore(redisUrl?: string, opts: CreateStoreOptions = {}): Promise<KVStore> {
  const url = redisUrl || process.env.REDIS_URL;

  if (!url || url === 'memory') {
    return new MemoryStore();
  }

  const envTimeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS);
  const timeoutMs =
    opts.connectTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_CONNECT_TIMEOUT_MS);
  const store = new RedisStore(url);
  try {
    await store.waitUntilReady(timeoutMs);
    await store.ping();
    return store;
  } catch (err) {
    const fallback =
      'falling back to in-memory store (ephemeral, per-process: jobs will NOT reach other processes and are lost on restart). ' +
      'Redis is required for production durability.';
    if (opts.warn) {
      opts.warn(`[workers] Redis unavailable at ${redactUrl(url)} (${err instanceof Error ? err.message : String(err)}) — ${fallback}`);
    } else {
      logger.warn(`Redis unavailable — ${fallback}`, {
        operation: 'create-store',
        errorCode: 'REDIS_UNAVAILABLE',
        status: 'degraded',
        redisUrl: redactUrl(url),
        error: err,
      });
    }
    await store.quit?.();
    return new MemoryStore();
  }
}

export { MemoryStore } from './store.memory';
export { RedisStore } from './store.redis';
export type { KVStore } from './store';
