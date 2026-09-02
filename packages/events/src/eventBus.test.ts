import { describe, it, expect, afterEach } from 'vitest';
import { EventBus } from './index';
import { TransactionEvent } from '@company/schemas';

function makeEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    id: 'tx_' + Math.random().toString(36).substring(2, 10),
    timestamp: new Date().toISOString(),
    appId: 'reachchurch',
    category: 'payment',
    providerId: 'stripe',
    status: 'success',
    latency: 10,
    cost: 0.1,
    decisionReason: 'test',
    payload: {},
    response: {},
    ...overrides
  };
}

describe('EventBus', () => {
  afterEach(() => {
    EventBus.getInstance().clearHistory();
  });

  it('delivers emitted events to subscribed listeners', () => {
    const bus = EventBus.getInstance();
    const received: TransactionEvent[] = [];
    bus.subscribe((event) => received.push(event));

    const event = makeEvent({ providerId: 'nmi' });
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = EventBus.getInstance();
    const received: TransactionEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));
    unsubscribe();

    bus.emit(makeEvent());

    expect(received).toHaveLength(0);
  });

  it('keeps history bounded to the latest 100 events (newest first)', () => {
    const bus = EventBus.getInstance();
    for (let i = 0; i < 120; i++) {
      bus.emit(makeEvent({ providerId: `p${i}` }));
    }

    const history = bus.getHistory();
    expect(history).toHaveLength(100);
    expect(history[0].providerId).toBe('p119');
    expect(history[99].providerId).toBe('p20');
  });

  it('a throwing listener does not prevent delivery to other listeners', () => {
    const bus = EventBus.getInstance();
    const received: TransactionEvent[] = [];
    bus.subscribe(() => {
      throw new Error('listener exploded');
    });
    bus.subscribe((event) => received.push(event));

    expect(() => bus.emit(makeEvent())).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it('clearHistory empties the log', () => {
    const bus = EventBus.getInstance();
    bus.emit(makeEvent());
    bus.clearHistory();
    expect(bus.getHistory()).toHaveLength(0);
  });
});