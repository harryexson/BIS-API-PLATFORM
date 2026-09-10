import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { CompanyApiClient, ApiError } from './index';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_test', ...headers },
  });
}

describe('CompanyApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a tenantId, since the gateway rejects requests without one', () => {
    expect(() => new CompanyApiClient({ apiKey: 'k' } as any)).toThrow(/tenantId/);
  });

  it('payments.create posts to /v1/api/gateway/payment with auth, tenant, and idempotency headers', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({
        id: 'tx_1', timestamp: 'now', appId: 'a', category: 'payment', providerId: 'stripe',
        status: 'success', amount: 4999, currency: 'USD', latency: 10, cost: 0.1,
        decisionReason: 'test', payload: {}, response: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new CompanyApiClient({ apiKey: 'sk_live_x', tenantId: 'ten_1', fetchImpl: fetchMock as any });
    const event = await client.payments.create(
      { amount: 4999, currency: 'USD', paymentMethod: 'card' },
      { idempotencyKey: 'idem-1', correlationId: 'corr-1' },
    );

    expect(event.id).toBe('tx_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.company.com/v1/api/gateway/payment');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer sk_live_x');
    expect(init.headers['x-tenant-id']).toBe('ten_1');
    expect(init.headers['x-idempotency-key']).toBe('idem-1');
    expect(init.headers['x-correlation-id']).toBe('corr-1');
    expect(JSON.parse(init.body)).toMatchObject({ amount: 4999, currency: 'USD' });
  });

  it('defaults to the sandbox base URL when environment is sandbox', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ status: 'healthy', service: 'api-gateway', timestamp: 'now' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'sk_test_x', tenantId: 'ten_1', environment: 'sandbox', fetchImpl: fetchMock as any });
    await client.health.get();
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.api.company.com/health');
  });

  it('throws ApiError with the gateway\'s flat error message and request id on failure', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ error: 'Admin key required' }, 403, { 'X-Request-Id': 'req_x' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'bad', tenantId: 'ten_1', fetchImpl: fetchMock as any });

    await expect(client.payments.get('tx_1')).rejects.toMatchObject({
      status: 403,
      message: 'Admin key required',
      requestId: 'req_x',
    });
  });

  it('providers.list forwards filter query params to /v1/api/gateway/providers', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ providers: [], count: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'k', tenantId: 'ten_1', fetchImpl: fetchMock as any });

    await client.providers.list({ category: 'payment', currency: 'MWK' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1/api/gateway/providers');
    expect(url.searchParams.get('category')).toBe('payment');
    expect(url.searchParams.get('currency')).toBe('MWK');
  });

  it('providers.get finds a provider by id from list() client-side (no dedicated server endpoint)', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({ providers: [{ id: 'stripe', name: 'Stripe' }], count: 1 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'k', tenantId: 'ten_1', fetchImpl: fetchMock as any });

    const provider = await client.providers.get('stripe');
    expect(provider?.id).toBe('stripe');
  });

  it('messages.send and messages.get hit the real gateway paths', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({
        id: 'tx_2', timestamp: 'now', appId: 'a', category: 'messaging', providerId: 'signalhouse',
        status: 'success', latency: 10, cost: 0.01, decisionReason: 'test', payload: {}, response: {},
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CompanyApiClient({ apiKey: 'k', tenantId: 'ten_1', fetchImpl: fetchMock as any });

    await client.messages.send({ recipient: '+1', content: 'hi' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.company.com/v1/api/gateway/messaging');

    await client.messages.get('tx_2');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.company.com/v1/api/gateway/transaction/tx_2');
  });

  it('webhooks.verify accepts a valid signature and rejects a bad one', async () => {
    const client = new CompanyApiClient({ apiKey: 'k', tenantId: 'ten_1' });
    const secret = 'whsec_test';
    const body = JSON.stringify({
      id: 'tx_3', timestamp: 'now', appId: 'a', category: 'payment', providerId: 'stripe',
      status: 'success', latency: 1, cost: 0, decisionReason: 'test', payload: {}, response: {},
    });
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

    expect(client.webhooks.verify(body, signature, secret)).toBe(true);
    expect(client.webhooks.verify(body, 'sha256=deadbeef', secret)).toBe(false);
    expect(client.webhooks.constructEvent(body, signature, secret).id).toBe('tx_3');
    expect(() => client.webhooks.constructEvent(body, 'sha256=wrong', secret)).toThrow(ApiError);
  });
});
