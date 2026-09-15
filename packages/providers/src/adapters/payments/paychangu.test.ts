import { describe, it, expect, afterEach, vi } from 'vitest';
import { PayChanguProvider } from './paychangu';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'paychangu',
    name: 'PayChangu',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 1.5,
    ...overrides,
  };
}

describe('PayChanguProvider', () => {
  const originalApiKey = process.env.PAYCHANGU_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.PAYCHANGU_API_KEY;
    else process.env.PAYCHANGU_API_KEY = originalApiKey;
  });

  describe('isConfigured()', () => {
    it('is false with no credentials, true once set via env or setSecrets()', () => {
      delete process.env.PAYCHANGU_API_KEY;
      const provider = new PayChanguProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.PAYCHANGU_API_KEY = 'test-key';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.PAYCHANGU_API_KEY;
      provider.setSecrets({ api_key: 'from_admin' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without an API key configured (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.PAYCHANGU_API_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 5000, currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265990000000' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.data.id).toMatch(/^pc-/);
    });
  });

  describe('with an API key but no operator reference id', () => {
    it('falls back to simulated rather than guessing an operator ref id', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 5000, currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265990000000' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with an API key and an operator reference id (real HTTP path)', () => {
    const validPayload = {
      amount: 5000,
      currency: 'MWK',
      paymentMethod: 'mobile_money',
      phoneNumber: '265990000000',
      metadata: { paychanguOperatorRefId: 'op-airtel-mw-1' },
    };

    it('sends a JSON body to POST /mobile-money/payments/initialize with Bearer auth', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'success', message: 'Charge initiated', data: { charge_id: 'charge-1', status: 'success' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.paychangu.com/mobile-money/payments/initialize');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer test-key');
      const body = JSON.parse(opts.body);
      expect(body.mobile_money_operator_ref_id).toBe('op-airtel-mw-1');
      expect(body.mobile).toBe('265990000000');
      expect(body.amount).toBe(5000);

      expect(event.status).toBe('success');
      expect(event.id).toBe('charge-1');
    });

    it('reports an unresolved outcome (unknown, not failed) when data.status is "pending"', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'success', message: 'Charge pending', data: { charge_id: 'charge-2', status: 'pending' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('unknown');
    });

    it('reports failure when data.status is "failed"', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'success', message: 'Charge attempted', data: { charge_id: 'charge-3', status: 'failed', message: 'Insufficient funds' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Insufficient funds');
    });

    it('does not fabricate a success from a 200 response whose top-level status is "error"', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'error', message: 'Invalid operator reference id' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid operator reference id');
    });

    it('parses the assumed error envelope on a non-2xx response', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'error', message: 'Unauthorized' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Unauthorized');
    });

    it('retries on 5xx (via BaseProvider.http_request) and eventually reports failure if every attempt fails', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'error', message: 'Internal error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(event.status).toBe('failed');
    }, 15_000);

    it('reports offline/maintenance status without making an HTTP call', async () => {
      process.env.PAYCHANGU_API_KEY = 'test-key';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayChanguProvider(makeConfig({ status: 'offline' }));
      await expect(provider.processRequest('app1', validPayload, 'test')).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
