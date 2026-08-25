import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  EventSubscriber,
  InMemoryIdempotencyStore,
  computeSignature
} from './index';
import { PlatformEvent } from './types';

function makeEvent(type: string, id = 'ev_1'): PlatformEvent {
  return {
    id,
    object: 'event',
    type,
    created_at: '2026-08-24T12:00:00Z',
    livemode: true,
    data: { foo: 'bar' }
  };
}

function sign(body: string, secret = 'whsec_test') {
  return 'sha256=' + computeSignature(body, secret);
}

describe('EventSubscriber', () => {
  it('publish notifies only matching subscribers', async () => {
    const sub = new EventSubscriber();
    const paymentHandler = vi.fn();
    const messageHandler = vi.fn();

    sub.subscribe('payment.succeeded', paymentHandler);
    sub.subscribe(['message.delivered', 'message.failed'], messageHandler);

    await sub.publish(makeEvent('payment.succeeded'));
    await sub.publish(makeEvent('message.failed'));

    expect(paymentHandler).toHaveBeenCalledTimes(1);
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops delivery', async () => {
    const sub = new EventSubscriber();
    const handler = vi.fn();
    const off = sub.subscribe('payment.succeeded', handler);
    off();
    await sub.publish(makeEvent('payment.succeeded'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('verifyWebhook returns true for a valid signature and false otherwise', () => {
    const sub = new EventSubscriber();
    const body = JSON.stringify(makeEvent('payment.succeeded'));
    expect(sub.verifyWebhook(body, sign(body), 'whsec_test')).toBe(true);
    expect(sub.verifyWebhook(body, 'sha256=deadbeef', 'whsec_test')).toBe(false);
  });

  it('processWebhook dispatches to handlers on a valid signature', async () => {
    const sub = new EventSubscriber();
    const handler = vi.fn();
    sub.subscribe('payment.succeeded', handler);

    const body = JSON.stringify(makeEvent('payment.succeeded', 'ev_dispatch'));
    const result = await sub.processWebhook(body, sign(body), 'whsec_test');

    expect(result.status).toBe('dispatched');
    expect(result.matched).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('processWebhook is idempotent for duplicate deliveries', async () => {
    const sub = new EventSubscriber();
    const handler = vi.fn();
    sub.subscribe('payment.succeeded', handler);

    const body = JSON.stringify(makeEvent('payment.succeeded', 'ev_dup'));
    const first = await sub.processWebhook(body, sign(body), 'whsec_test');
    const second = await sub.processWebhook(body, sign(body), 'whsec_test');

    expect(first.status).toBe('dispatched');
    expect(second.status).toBe('duplicate');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('processWebhook returns invalid_signature when verification fails', async () => {
    const sub = new EventSubscriber();
    const handler = vi.fn();
    sub.subscribe('payment.succeeded', handler);

    const body = JSON.stringify(makeEvent('payment.succeeded', 'ev_bad'));
    const result = await sub.processWebhook(body, 'sha256=wrong', 'whsec_test');

    expect(result.status).toBe('invalid_signature');
    expect(handler).not.toHaveBeenCalled();
  });

  it('processWebhook returns ignored when no handler matches', async () => {
    const sub = new EventSubscriber();
    const handler = vi.fn();
    sub.subscribe('payment.succeeded', handler);

    const body = JSON.stringify(makeEvent('order.shipped', 'ev_ship'));
    const result = await sub.processWebhook(body, sign(body), 'whsec_test');

    expect(result.status).toBe('ignored');
    expect(handler).not.toHaveBeenCalled();
  });

  it('collects handler errors and invokes onError', async () => {
    const onError = vi.fn();
    const sub = new EventSubscriber({ onError });
    sub.subscribe('payment.failed', () => {
      throw new Error('boom');
    });

    const body = JSON.stringify(makeEvent('payment.failed', 'ev_err'));
    const result = await sub.processWebhook(body, sign(body), 'whsec_test');

    expect(result.status).toBe('dispatched');
    expect(result.errors).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('honors a custom idempotency store', async () => {
    const store = new InMemoryIdempotencyStore();
    const spy = vi.spyOn(store, 'checkAndSet');
    const sub = new EventSubscriber({ idempotencyStore: store });
    sub.subscribe('payment.succeeded', vi.fn());

    const body = JSON.stringify(makeEvent('payment.succeeded', 'ev_store'));
    await sub.processWebhook(body, sign(body), 'whsec_test', { idempotencyStore: store });

    expect(spy).toHaveBeenCalledWith('ev_store');
  });

  it('supports all documented example event types', async () => {
    const sub = new EventSubscriber();
    const seen: string[] = [];
    for (const t of [
      'payment.succeeded',
      'payment.failed',
      'message.delivered',
      'message.failed',
      'order.shipped',
      'order.delivered'
    ]) {
      sub.subscribe(t, (e) => { seen.push(e.type); });
    }
    for (const t of [
      'payment.succeeded',
      'payment.failed',
      'message.delivered',
      'message.failed',
      'order.shipped',
      'order.delivered'
    ]) {
      await sub.publish(makeEvent(t, 'ev_' + t));
    }
    expect(seen.sort()).toEqual([
      'message.delivered',
      'message.failed',
      'order.delivered',
      'order.shipped',
      'payment.failed',
      'payment.succeeded'
    ]);
  });
});
