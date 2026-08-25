import {
  EventHandler,
  EventSubscriberOptions,
  IdempotencyStore,
  PlatformEvent,
  ProcessResult,
  Unsubscribe
} from './types';
import { InMemoryIdempotencyStore } from './store';
import { parseEvent, verifySignature } from './verify';

interface Subscription {
  types: Set<string>;
  handler: EventHandler;
}

export class EventSubscriber {
  private readonly subscriptions: Subscription[] = [];
  private readonly store: IdempotencyStore;
  private readonly onError?: (event: PlatformEvent, error: unknown) => void;

  constructor(options: EventSubscriberOptions = {}) {
    this.store = options.idempotencyStore || new InMemoryIdempotencyStore();
    this.onError = options.onError;
  }

  subscribe(types: string | string[], handler: EventHandler): Unsubscribe {
    const list = Array.isArray(types) ? types : [types];
    const subscription: Subscription = { types: new Set(list), handler };
    this.subscriptions.push(subscription);
    return () => {
      const idx = this.subscriptions.indexOf(subscription);
      if (idx !== -1) this.subscriptions.splice(idx, 1);
    };
  }

  async publish(event: PlatformEvent): Promise<void> {
    await this.dispatch(event, this.subscriptions);
  }

  verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
    return verifySignature(rawBody, signature, secret);
  }

  async processWebhook(
    rawBody: string,
    signature: string,
    secret: string,
    options?: EventSubscriberOptions
  ): Promise<ProcessResult> {
    if (!verifySignature(rawBody, signature, secret)) {
      return { status: 'invalid_signature', matched: 0, errors: [] };
    }

    let event: PlatformEvent;
    try {
      event = parseEvent(rawBody);
    } catch {
      return { status: 'invalid_signature', matched: 0, errors: [] };
    }

    const store = options?.idempotencyStore || this.store;
    const processed = await store.checkAndSet(event.id);
    if (!processed) {
      return { status: 'duplicate', event, matched: 0, errors: [] };
    }

    const matched = this.subscriptions.filter((s) => s.types.has(event.type));
    if (matched.length === 0) {
      return { status: 'ignored', event, matched: 0, errors: [] };
    }

    const errors = await this.dispatch(event, matched, options?.onError || this.onError);
    return { status: 'dispatched', event, matched: matched.length, errors };
  }

  private async dispatch(
    event: PlatformEvent,
    subscriptions: Subscription[],
    onError?: (event: PlatformEvent, error: unknown) => void
  ): Promise<Array<{ error: unknown }>> {
    const errors: Array<{ error: unknown }> = [];
    const results = await Promise.allSettled(
      subscriptions
        .filter((s) => s.types.has(event.type))
        .map((s) => Promise.resolve().then(() => s.handler(event)))
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push({ error: r.reason });
        if (onError) onError(event, r.reason);
      }
    }
    return errors;
  }
}
