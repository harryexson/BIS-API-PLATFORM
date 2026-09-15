import { describe, it, expect, afterEach, vi } from 'vitest';
import { AirwallexProvider } from './airwallex';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'airwallex',
    name: 'Airwallex',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 2.0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const validPayload = {
  amount: 100,
  currency: 'USD',
  paymentMethod: 'card',
  paymentToken: 'consent_abc123',
  metadata: { airwallexCustomerId: 'cus_xyz789' },
};

describe('AirwallexProvider', () => {
  const originalClientId = process.env.AIRWALLEX_CLIENT_ID;
  const originalApiKey = process.env.AIRWALLEX_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClientId === undefined) delete process.env.AIRWALLEX_CLIENT_ID;
    else process.env.AIRWALLEX_CLIENT_ID = originalClientId;
    if (originalApiKey === undefined) delete process.env.AIRWALLEX_API_KEY;
    else process.env.AIRWALLEX_API_KEY = originalApiKey;
  });

  describe('isConfigured()', () => {
    it('requires both client_id and api_key', () => {
      delete process.env.AIRWALLEX_CLIENT_ID;
      delete process.env.AIRWALLEX_API_KEY;
      const provider = new AirwallexProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.AIRWALLEX_CLIENT_ID = 'client_123';
      expect(provider.isConfigured()).toBe(false);

      process.env.AIRWALLEX_API_KEY = 'key_123';
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without credentials configured (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.AIRWALLEX_CLIENT_ID;
      delete process.env.AIRWALLEX_API_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 100, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.id).toMatch(/^evt_/);
    });
  });

  describe('with credentials but missing a paymentToken or customer id', () => {
    it('falls back to simulated when there is no paymentToken', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 100, currency: 'USD', paymentMethod: 'card', metadata: { airwallexCustomerId: 'cus_xyz789' } },
        'test',
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });

    it('falls back to simulated when there is no customer id', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 100, currency: 'USD', paymentMethod: 'card', paymentToken: 'consent_abc123' },
        'test',
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with credentials, a paymentToken, and a customer id (real HTTP path)', () => {
    it('logs in, creates a PaymentIntent, and confirms it — three real calls in order', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'access-token-1', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_123', status: 'REQUIRES_PAYMENT_METHOD' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_123', status: 'SUCCEEDED', amount: 100, currency: 'USD' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(3);

      const [loginUrl, loginOpts] = fetchSpy.mock.calls[0];
      expect(loginUrl).toBe('https://api.airwallex.com/api/v1/authentication/login');
      expect(loginOpts.headers['x-client-id']).toBe('client-1');
      expect(loginOpts.headers['x-api-key']).toBe('key-1');

      const [createUrl, createOpts] = fetchSpy.mock.calls[1];
      expect(createUrl).toBe('https://api.airwallex.com/api/v1/pa/payment_intents/create');
      expect(createOpts.headers.Authorization).toBe('Bearer access-token-1');
      const createBody = JSON.parse(createOpts.body);
      expect(createBody.amount).toBe(100);
      expect(createBody.currency).toBe('USD');

      const [confirmUrl, confirmOpts] = fetchSpy.mock.calls[2];
      expect(confirmUrl).toBe('https://api.airwallex.com/api/v1/pa/payment_intents/int_123/confirm');
      const confirmBody = JSON.parse(confirmOpts.body);
      expect(confirmBody.customer_id).toBe('cus_xyz789');
      expect(confirmBody.payment_consent_id).toBe('consent_abc123');

      expect(event.status).toBe('success');
      expect(event.id).toBe('int_123');
    });

    it('reuses a cached access token across calls instead of logging in every time', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'access-token-1', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_1', status: 'REQUIRES_PAYMENT_METHOD' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_1', status: 'SUCCEEDED' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_2', status: 'REQUIRES_PAYMENT_METHOD' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_2', status: 'SUCCEEDED' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      await provider.processRequest('app1', validPayload, 'test');
      await provider.processRequest('app1', validPayload, 'test');

      // 1 login + 2 create + 2 confirm = 5, not 6 — the second payment
      // reused the cached token rather than logging in again.
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    });

    it('reports an unresolved outcome (unknown, not failed) on REQUIRES_CUSTOMER_ACTION (e.g. 3DS)', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'access-token-1', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_3', status: 'REQUIRES_PAYMENT_METHOD' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_3', status: 'REQUIRES_CUSTOMER_ACTION' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('unknown');
    });

    it('reports failure when the confirm step declines the payment method', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'access-token-1', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_4', status: 'REQUIRES_PAYMENT_METHOD' }))
        .mockResolvedValueOnce(jsonResponse({ id: 'int_4', status: 'REQUIRES_PAYMENT_METHOD', message: 'Card declined' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Card declined');
    });

    it('reports failure when authentication itself fails', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'wrong-key';
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        jsonResponse({ code: 'unauthorized', message: 'Invalid API key' }, 401),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid API key');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("parses Airwallex's documented error envelope when creating the intent fails", async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ token: 'access-token-1', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }))
        .mockResolvedValueOnce(jsonResponse({ code: 'validation_failed', message: 'currency is required', source: 'currency' }, 400));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('currency is required');
    });

    it('reports offline/maintenance status without making an HTTP call', async () => {
      process.env.AIRWALLEX_CLIENT_ID = 'client-1';
      process.env.AIRWALLEX_API_KEY = 'key-1';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AirwallexProvider(makeConfig({ status: 'offline' }));
      await expect(provider.processRequest('app1', validPayload, 'test')).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
