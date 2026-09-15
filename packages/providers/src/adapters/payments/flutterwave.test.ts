import { describe, it, expect, afterEach, vi } from 'vitest';
import { FlutterwaveProvider } from './flutterwave';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'flutterwave',
    name: 'Flutterwave',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    ...overrides,
  };
}

describe('FlutterwaveProvider', () => {
  const originalApiKey = process.env.FLUTTERWAVE_SECRET_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.FLUTTERWAVE_SECRET_KEY;
    else process.env.FLUTTERWAVE_SECRET_KEY = originalApiKey;
  });

  describe('isConfigured()', () => {
    it('is false with no credentials, true once set via env or setSecrets()', () => {
      delete process.env.FLUTTERWAVE_SECRET_KEY;
      const provider = new FlutterwaveProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.FLUTTERWAVE_SECRET_KEY;
      provider.setSecrets({ api_key: 'FLWSECK_from_admin' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without an API key configured (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.FLUTTERWAVE_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 1000, currency: 'NGN', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.data.status).toBe('successful');
    });
  });

  describe('with an API key but missing a token or email', () => {
    it('falls back to simulated when there is no paymentToken', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 1000, currency: 'NGN', paymentMethod: 'card', metadata: { email: 'buyer@example.com' } },
        'test',
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });

    it('falls back to simulated when there is no customer email', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 1000, currency: 'NGN', paymentMethod: 'card', paymentToken: 'flw-t1nf-abc' },
        'test',
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with an API key, token, and email (real HTTP path)', () => {
    const validPayload = {
      amount: 1000,
      currency: 'NGN',
      paymentMethod: 'card',
      paymentToken: 'flw-t1nf-93da56b24f8ee332304cd2eea40a1fc4-m03k',
      metadata: { email: 'buyer@example.com' },
    };

    it('sends a JSON body to POST /v3/tokenized-charges with Bearer auth', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'success',
            message: 'Charge successful',
            data: { id: 12345, tx_ref: 'flw-ref-1', status: 'successful', processor_response: 'Approved' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.flutterwave.com/v3/tokenized-charges');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer FLWSECK_TEST');
      const body = JSON.parse(opts.body);
      expect(body.token).toBe(validPayload.paymentToken);
      expect(body.email).toBe('buyer@example.com');
      expect(body.currency).toBe('NGN');
      expect(body.country).toBe('NG');
      expect(body.amount).toBe(1000);

      expect(event.status).toBe('success');
      expect(event.id).toBe('12345');
    });

    it('reports failure when data.status is "failed", even though the top-level status is "success"', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'success',
            message: 'Charge attempted',
            data: { id: 999, status: 'failed', processor_response: 'Insufficient Funds' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Insufficient Funds');
    });

    it('reports an unresolved outcome (unknown, not failed) when data.status is "pending"', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'success', message: 'Charge pending', data: { id: 1000, status: 'pending' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('unknown');
    });

    it('does not fabricate a success from a 200 response whose top-level status is "error"', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'error', message: 'Invalid token supplied', data: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid token supplied');
    });

    it("parses Flutterwave's documented error envelope on a non-2xx response", async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'error', message: 'merchant secret key required', data: null }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('merchant secret key required');
    });

    it('retries on 5xx (via BaseProvider.http_request) and eventually reports failure if every attempt fails', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 'error', message: 'Internal error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(event.status).toBe('failed');
    }, 15_000);

    it('reports offline/maintenance status without making an HTTP call', async () => {
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new FlutterwaveProvider(makeConfig({ status: 'offline' }));
      await expect(provider.processRequest('app1', validPayload, 'test')).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
