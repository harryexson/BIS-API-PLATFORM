import { TransactionEvent } from '@company/schemas';
import { metrics } from '@company/observability';

type EventListener = (event: TransactionEvent) => void;

export class EventBus {
  private static instance: EventBus;
  private listeners: Set<EventListener> = new Set();
  private history: TransactionEvent[] = [];
  private maxHistory = 100;

  private constructor() {}

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: TransactionEvent) {
    this.history.unshift(event);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }
    this.listeners.forEach(listener => {
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

  public clearHistory() {
    this.history = [];
  }
}

export { WebhookDelivery, type WebhookTarget, type DeliveryAttempt } from './webhook-delivery';
