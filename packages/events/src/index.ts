import { TransactionEvent } from '@company/schemas';
import { metrics } from '@company/observability';

type EventListener = (event: TransactionEvent) => void;

const EVENT_CHANNEL = 'bis:events';
const HISTORY_KEY = 'bis:event_history';
const MAX_HISTORY = 1000;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * EventBus with Redis-backed pub/sub for cross-process event distribution.
 *
 * When REDIS_URL is set, events are published to Redis and all worker/gateway
 * instances receive them. History is stored in Redis for durability.
 *
 * When Redis is unavailable, falls back to in-memory only (single-process mode).
 */
export class EventBus {
  private static instance: EventBus;
  private listeners: Set<EventListener> = new Set();
  private history: TransactionEvent[] = [];
  private maxHistory = MAX_HISTORY;
  private redisClient: any = null;
  private subClient: any = null;
  private redisReady = false;
  private channelHandlers = new Map<string, Set<(msg: string) => void>>();

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
    if (!redisUrl) return;

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
        console.log('[eventbus] Redis connected');
      });

      this.redisClient.on('error', () => {
        this.redisReady = false;
      });

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
        console.error('Error executing event listener:', err);
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
