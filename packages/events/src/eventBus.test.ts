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

  it('keeps history bounded to the latest N events (newest first)', () => {
    const bus = EventBus.getInstance();
    const cap = 120; // below MAX_HISTORY (200,000), so this exercises ordering, not the cap
    for (let i = 0; i < cap; i++) {
      bus.emit(makeEvent({ providerId: `p${i}` }));
    }

    const history = bus.getHistory();
    expect(history).toHaveLength(cap);
    expect(history[0].providerId).toBe(`p${cap - 1}`);
    expect(history[cap - 1].providerId).toBe('p0');
  });

  it('keeps history bounded to MAX_HISTORY (200,000) when exceeded', () => {
    const bus = EventBus.getInstance();
    // Exercises the exact same unshift()+pop() eviction path as the real
    // cap at full scale (not a smaller stand-in) — this is the one test
    // that would actually catch a regression back to an unbounded array.
    // Array.prototype.unshift is O(n) per call, so this is the slowest
    // test in the suite by design; 200,000 is the real MAX_HISTORY, not
    // padding, so there's no smaller number that still proves the cap
    // itself (as opposed to just the ordering) holds at production scale.
    const total = 200_010;
    for (let i = 0; i < total; i++) {
      bus.emit(makeEvent({ providerId: `p${i}` }));
    }

    const history = bus.getHistory();
    expect(history).toHaveLength(200_000);
    expect(history[0].providerId).toBe(`p${total - 1}`);
    expect(history[199_999].providerId).toBe(`p${total - 200_000}`);
  }, 60_000);

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