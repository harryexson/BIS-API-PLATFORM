import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TransactionEvent } from '@company/schemas';
import { WebhookDelivery } from './webhook-delivery';

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
    ...overrides,
  };
}

describe('WebhookDelivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs the delivery with X-Webhook-Signature when the target has a secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery();
    const event = makeEvent();
    delivery.enqueue('wh_1', { url: 'https://example.com/hook', secret: 'whsec_test' }, event);

    await (delivery as any).processQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const expectedSignature = 'sha256=' + createHmac('sha256', 'whsec_test').update(init.body as string).digest('hex');
    expect(init.headers['X-Webhook-Signature']).toBe(expectedSignature);
    expect(JSON.parse(init.body as string)).toEqual(event);
  });

  it('sends no signature header when the target has no secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery();
    delivery.enqueue('wh_2', { url: 'https://example.com/hook' }, makeEvent());

    await (delivery as any).processQueue();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Webhook-Signature']).toBeUndefined();
  });

  it('retries with exponential backoff on failure and eventually dead-letters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const delivery = new WebhookDelivery(2);
    delivery.enqueue('wh_3', { url: 'https://example.com/hook' }, makeEvent());

    await (delivery as any).processQueue();
    expect(delivery.getStatus('wh_3')?.status).toBe('pending');

    // Force the retry backoff to have elapsed and try again.
    const attempt = (delivery as any).pending.get('wh_3');
    attempt.nextRetryAt = Date.now() - 1;
    await (delivery as any).processQueue();

    expect(delivery.getStatus('wh_3')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
