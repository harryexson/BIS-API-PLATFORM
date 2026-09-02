import { TransactionEvent } from '@company/schemas';
import { logger, metrics } from '@company/observability';

export interface WebhookTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface DeliveryAttempt {
  webhookId: string;
  target: WebhookTarget;
  event: TransactionEvent;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  error?: string;
  deliveredAt?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;

export class WebhookDelivery {
  private pending: Map<string, DeliveryAttempt> = new Map();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private maxAttempts: number = MAX_ATTEMPTS) {}

  /**
   * Enqueue a webhook delivery with exponential backoff retry.
   */
  enqueue(
    webhookId: string,
    target: WebhookTarget,
    event: TransactionEvent,
  ): void {
    const attempt: DeliveryAttempt = {
      webhookId,
      target,
      event,
      attempt: 0,
      maxAttempts: this.maxAttempts,
      nextRetryAt: Date.now(),
      status: 'pending',
    };
    this.pending.set(webhookId, attempt);
    this.scheduleNext();
  }

  /**
   * Start the retry loop (call once at startup).
   */
  start(): void {
    this.timer = setInterval(() => this.processQueue(), 5_000);
  }

  /**
   * Stop the retry loop.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Get delivery status for a webhook.
   */
  getStatus(webhookId: string): DeliveryAttempt | undefined {
    return this.pending.get(webhookId);
  }

  /**
   * Get all pending deliveries.
   */
  getPending(): DeliveryAttempt[] {
    return Array.from(this.pending.values()).filter((d) => d.status === 'pending');
  }

  private scheduleNext(): void {
    // Timer will pick up pending items on next tick
  }

  private async processQueue(): Promise<void> {
    const now = Date.now();
    for (const [id, attempt] of this.pending) {
      if (attempt.status !== 'pending') continue;
      if (attempt.nextRetryAt > now) continue;

      attempt.attempt++;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        const res = await fetch(attempt.target.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Id': id,
            'X-Webhook-Attempt': String(attempt.attempt),
            ...attempt.target.headers,
          },
          body: JSON.stringify(attempt.event),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.ok) {
          attempt.status = 'delivered';
          attempt.deliveredAt = new Date().toISOString();
          metrics.increment('webhookDeliveries');
          logger.info('webhook delivered', {
            operation: 'webhook-delivery',
            webhookId: id,
            attempt: attempt.attempt,
            status: 'success',
          });
          this.pending.delete(id);
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err: any) {
        attempt.error = err.message;

        if (attempt.attempt >= attempt.maxAttempts) {
          attempt.status = 'dead';
          metrics.increment('webhookDeadLetters');
          logger.error('webhook delivery failed permanently', {
            operation: 'webhook-delivery',
            webhookId: id,
            attempt: attempt.attempt,
            errorCode: 'WEBHOOK_DEAD',
            status: 'failed',
          });
          this.pending.delete(id);
        } else {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at 60s)
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt.attempt - 1), MAX_DELAY_MS);
          attempt.nextRetryAt = now + delay;
          logger.warn('webhook delivery failed, will retry', {
            operation: 'webhook-delivery',
            webhookId: id,
            attempt: attempt.attempt,
            nextRetryIn: delay,
            errorCode: 'WEBHOOK_RETRY',
          });
        }
      }
    }
  }
}
