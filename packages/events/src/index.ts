import { TransactionEvent } from '@company/schemas';
import { logger, metrics } from '@company/observability';

type EventListener = (event: TransactionEvent) => void;

const EVENT_CHANNEL = 'bis:events';
const HISTORY_KEY = 'bis:event_history';
// P0: Bumped from 1000. EventBus.getInstance() is a true process-wide
// singleton, and packages/simulation's test harness boots the REAL gateway
// (and its REAL EventBus) rather than a per-test instance — so its history
// accumulates across every simulation test file that runs in the same
// worker process, not just the current test. At 1000, a full simulation
// suite run legitimately pushed the cap before later files' tests ran,
// silently breaking any test using the mark()/busEventsAfter() pattern
// (token = history.length at mark time; once history is capped, length
// stops growing even as events keep flowing, so "events since token"
// always read back as zero) — e.g. donation-system.simulation.test.ts's
// giving-receipt assertions. Several unrelated simulation test files also
// filter getHistory() by event *timestamp*, not array position — so it's
// not just "since token" arithmetic that breaks near the cap, it's the
// underlying event actually getting evicted (popped) from the shared
// singleton's bounded array by the sheer combined volume of every other
// concurrently-running test before this test ever reads it back. 200,000
// gives a full suite run comfortable headroom — some tests (e.g.
// resilience-failure's R10) deliberately push thousands of jobs/events
// through in a single test — while still bounding memory for a
// long-running production process (each TransactionEvent is small).
const MAX_HISTORY = 200_000;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * EventBus with Redis-backed pub/sub for cross-process event distribution.
 *
 * When REDIS_URL is set, events are published to Redis and all worker/gateway
 * instances receive them. History is stored in Redis for durability.
 *
 * When Redis is unavailable, falls back to in-memory only (single-process mode).
 */
/** emitOrThrow(): the cross-process publish did not happen. */
export class EventBusPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventBusPublishError';
  }
}

export class EventBus {
  private static instance: EventBus;
  private listeners: Set<EventListener> = new Set();
  private history: TransactionEvent[] = [];
  private maxHistory = MAX_HISTORY;
  private redisClient: any = null;
  private subClient: any = null;
  private redisReady = false;
  private redisConfigured = false;
  private channelHandlers = new Map<string, Set<(msg: string) => void>>();
  /** Connections whose current outage has already been logged (see initRedis). */
  private redisErrorLogged = new Set<'publish' | 'subscribe'>();

  private constructor() {
    this.initRedis();
  }

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  private initRedis(): void {
    const redisUrl = process.env.REDIS_URL;
    // 'memory' is createStore()'s explicit single-process sentinel
    // (@company/workers) — not a Redis host. Phase 19: honour it here too, so
    // that mode isn't reported (by /ready) as a Redis that never connects.
    if (!redisUrl || redisUrl === 'memory') return;
    this.redisConfigured = true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const Redis = require('ioredis');
      this.redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy(times: number) {
          // Reconnect with exponential backoff, max 30s
          const delay = Math.min(times * 200, 30_000);
          return delay;
        },
      });

      this.subClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        lazyConnect: true,
        retryStrategy(times: number) {
          const delay = Math.min(times * 200, 30_000);
          return delay;
        },
      });

      // Handle reconnection
      this.redisClient.on('connect', () => {
        this.redisReady = true;
        logger.info('event bus Redis connected', { operation: 'eventbus-redis', connection: 'publish', status: 'connected' });
      });

      // Phase 22 (gap register PHASE19-05): BOTH connections get an 'error'
      // listener. Without one on the subscriber, ioredis prints a raw
      // "[ioredis] Unhandled error event" (stack included) to stderr on every
      // failed reconnect. Each outage is logged ONCE per connection, as a
      // structured (redacted) entry; the flag re-arms on 'ready'.
      this.redisClient.on('error', (err: unknown) => {
        this.redisReady = false;
        this.logRedisError('publish', err);
      });
      this.redisClient.on('ready', () => this.redisErrorLogged.delete('publish'));

      this.subClient.on('error', (err: unknown) => this.logRedisError('subscribe', err));
      this.subClient.on('ready', () => this.redisErrorLogged.delete('subscribe'));

      this.subClient.on('message', (channel: string, message: string) => {
        const handlers = this.channelHandlers.get(channel);
        if (handlers) {
          handlers.forEach((h) => h(message));
        }
      });

      // Connect lazily
      this.redisClient.connect().catch(() => undefined);
      this.subClient.connect().catch(() => undefined);
    } catch {
      // ioredis not available — stay in-memory mode
    }
  }

  private logRedisError(connection: 'publish' | 'subscribe', err: unknown): void {
    if (this.redisErrorLogged.has(connection)) return;
    this.redisErrorLogged.add(connection);
    logger.error('event bus Redis connection error — retrying in the background', {
      operation: 'eventbus-redis',
      connection,
      errorCode: 'EVENTBUS_REDIS_ERROR',
      status: 'disconnected',
      error: err,
    });
  }

  /**
   * Phase 19 (gap register B13/C6): the cross-process publish connection's
   * ACTUAL state, for /ready. Read from the ioredis client's own status
   * ('ready' = commands can be sent) rather than `redisReady`, which is set
   * on socket connect (before the ready check) and only cleared on 'error'.
   * Says nothing about whether any other process is subscribed to the
   * channel (gap register PHASE7-01: none is).
   */
  public getRedisStatus(): 'not-configured' | 'connected' | 'disconnected' {
    if (!this.redisConfigured) return 'not-configured';
    return this.redisClient?.status === 'ready' ? 'connected' : 'disconnected';
  }

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Redis channel subscription helper (used internally for cross-process events).
   */
  private async subscribeChannel(channel: string, handler: (msg: string) => void): Promise<() => void> {
    if (!this.subClient) return () => {};

    if (!this.channelHandlers.has(channel)) {
      this.channelHandlers.set(channel, new Set());
      await this.subClient.subscribe(channel).catch(() => undefined);
    }
    this.channelHandlers.get(channel)!.add(handler);
    return () => {
      const handlers = this.channelHandlers.get(channel);
      if (!handlers) return;
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.channelHandlers.delete(channel);
        this.subClient.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  public async emit(event: TransactionEvent): Promise<void> {
    // Always keep local history
    this.history.unshift(event);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    // Publish to Redis for cross-process distribution
    if (this.redisReady && this.redisClient) {
      try {
        await this.redisClient.publish(EVENT_CHANNEL, JSON.stringify(event));

        // Store in Redis history list (capped at MAX_HISTORY)
        await this.redisClient.lpush(HISTORY_KEY, JSON.stringify(event));
        await this.redisClient.ltrim(HISTORY_KEY, 0, MAX_HISTORY - 1);
        await this.redisClient.expire(HISTORY_KEY, Math.floor(HISTORY_TTL_MS / 1000));

        metrics.increment('eventsEmittedRedis');
      } catch {
        // Redis unavailable — fall back to local emit only
        metrics.increment('eventsEmitFailed');
      }
    }

    // Always emit to local listeners
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        metrics.increment('queueFailures');
        logger.error('event listener threw', {
          operation: 'eventbus-dispatch',
          errorCode: 'EVENT_LISTENER_FAILED',
          status: 'failed',
          eventId: event.id,
          error: err,
        });
      }
    });
  }

  /**
   * Phase 5 (transactional outbox): like emit(), but a failed cross-process
   * publish is REPORTED (thrown) instead of swallowed, so the caller — the
   * outbox poller — leaves the outbox row un-completed and retries it,
   * rather than marking it delivered while Redis was down (silent loss).
   *
   * - Redis configured (REDIS_URL): the PUBLISH must succeed, otherwise this
   *   throws EventBusPublishError and local listeners are NOT invoked (so a
   *   retry does not hand them the same event twice). The capped history
   *   list is best-effort, as in emit().
   * - Redis not configured: single-process mode; local delivery is the
   *   only delivery there is, exactly as emit().
   *
   * Delivery is at least once: a publish that reached Redis but whose reply
   * was lost is retried. Consumers de-duplicate on `event.id`, which the
   * outbox poller sets to the outbox row id (stable across retries/replays).
   */
  public async emitOrThrow(event: TransactionEvent): Promise<void> {
    if (this.redisClient) {
      if (!this.redisReady) {
        metrics.increment('eventsEmitFailed');
        throw new EventBusPublishError('Redis event channel not connected');
      }
      try {
        await this.redisClient.publish(EVENT_CHANNEL, JSON.stringify(event));
      } catch (err) {
        metrics.increment('eventsEmitFailed');
        throw new EventBusPublishError(`Redis publish failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      metrics.increment('eventsEmittedRedis');
      try {
        await this.redisClient.lpush(HISTORY_KEY, JSON.stringify(event));
        await this.redisClient.ltrim(HISTORY_KEY, 0, MAX_HISTORY - 1);
        await this.redisClient.expire(HISTORY_KEY, Math.floor(HISTORY_TTL_MS / 1000));
      } catch {
        // History is a convenience cache, not the delivery.
      }
    }

    this.history.unshift(event);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        metrics.increment('queueFailures');
        logger.error('event listener threw', {
          operation: 'eventbus-dispatch',
          errorCode: 'EVENT_LISTENER_FAILED',
          status: 'failed',
          eventId: event.id,
          error: err,
        });
      }
    });
  }

  public getHistory(): TransactionEvent[] {
    return this.history;
  }

  /**
   * Get history from Redis (cross-process) with local fallback.
   */
  public async getDistributedHistory(limit: number = MAX_HISTORY): Promise<TransactionEvent[]> {
    if (this.redisReady && this.redisClient) {
      try {
        const raw = await this.redisClient.lrange(HISTORY_KEY, 0, limit - 1);
        return raw.map((r: string) => JSON.parse(r) as TransactionEvent);
      } catch {
        // Fall back to local history
      }
    }
    return this.history.slice(0, limit);
  }

  public clearHistory(): void {
    this.history = [];
    if (this.redisReady && this.redisClient) {
      this.redisClient.del(HISTORY_KEY).catch(() => undefined);
    }
  }
}

export { WebhookDelivery, type WebhookTarget, type DeliveryAttempt } from './webhook-delivery';
