import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { CompanyApiClient, ApiError } from './index';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_test', ...headers }
  });
}

describe('CompanyApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('payments.create posts with auth, idempotency, and body', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ id: 'pay_1', object: 'payment', status: 'success', amount: 4999, currency: 'USD', app_id: 'a', created_at: 'now' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new CompanyApiClient({ apiKey: 'sk_live_x', fetchImpl: fetchMock as any });
    const payment = await client.payments.create(
      { app_id: 'a', amount: 4999, currency: 'USD', payment_method: 'card' },
      { idempotencyKey: 'idem-1', correlationId: 'corr-1' }
    );

    expect(payment.id).toBe('pay_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.company.com/v1/payments');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer sk_live_x');
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    expect(init.headers['X-Correlation-Id']).toBe('corr-1');
    expect(JSON.parse(init.body)).toMatchObject({ amount: 4999, currency: 'USD' });
  });

  it('defaults to the sandbox base URL when environment is sandbox', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ status: 'healthy', timestamp: 'now' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'sk_test_x', environment: 'sandbox', fetchImpl: fetchMock as any });
    await client.health.get();
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.api.company.com/v1/health');
  });

  it('throws ApiError with code and request id on failure', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ error: { code: 'authentication_failed', message: 'bad key', request_id: 'req_x' } }, 401, { 'X-Request-Id': 'req_x' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'bad', fetchImpl: fetchMock as any });

    await expect(client.payments.get('pay_1')).rejects.toMatchObject({
      status: 401,
      code: 'authentication_failed',
      requestId: 'req_x'
    });
  });

  it('providers.list forwards filter + pagination query params', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ object: 'list', data: [], has_more: false })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'k', fetchImpl: fetchMock as any });

    await client.providers.list({ category: 'payment', country: 'MW', limit: 10, cursor: 'cur_1' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1/providers');
    expect(url.searchParams.get('category')).toBe('payment');
    expect(url.searchParams.get('country')).toBe('MW');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('cursor')).toBe('cur_1');
  });

  it('messages.send and messages.get hit the right paths', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ id: 'msg_1', object: 'message', status: 'queued', channel: 'sms', recipient: '+1', app_id: 'a', created_at: 'now' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'k', fetchImpl: fetchMock as any });

    await client.messages.send({ app_id: 'a', channel: 'sms', recipient: '+1', content: 'hi' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.company.com/v1/messages');

    await client.messages.get('msg_1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.company.com/v1/messages/msg_1');
  });

  it('webhooks.verify accepts a valid signature and rejects a bad one', async () => {
    const client = new CompanyApiClient({ apiKey: 'k' });
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'ev_1', object: 'event', type: 'payment.succeeded', created_at: 'now', livemode: true, data: {} });
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

    expect(client.webhooks.verify(body, signature, secret)).toBe(true);
    expect(client.webhooks.verify(body, 'sha256=deadbeef', secret)).toBe(false);
    expect(client.webhooks.constructEvent(body, signature, secret).id).toBe('ev_1');
    expect(() => client.webhooks.constructEvent(body, 'sha256=wrong', secret)).toThrow(ApiError);
  });
});
