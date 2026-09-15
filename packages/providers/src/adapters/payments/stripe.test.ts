import { describe, it, expect, afterEach, vi } from 'vitest';
import { StripeProvider } from './stripe';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'stripe',
    name: 'Stripe',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 2.9,
    transactionFeeFlat: 0.3,
    ...overrides,
  };
}

describe('StripeProvider', () => {
  const originalApiKey = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalApiKey;
  });

  describe('isConfigured()', () => {
    it('is false with no credentials, true once set via env or setSecrets()', () => {
      delete process.env.STRIPE_SECRET_KEY;
      const provider = new StripeProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.STRIPE_SECRET_KEY;
      expect(provider.isConfigured()).toBe(false);
      provider.setSecrets({ api_key: 'sk_live_from_admin_console' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without an API key configured (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.id).toMatch(/^pi_/);
    });
  });

  describe('with an API key but no paymentToken (no instrument to charge)', () => {
    it('falls back to simulated rather than calling Stripe with nothing to charge', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with an API key and a paymentToken (real HTTP path)', () => {
    it('sends a form-urlencoded body (not JSON) to POST /v1/payment_intents with Bearer auth', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'pi_abc123', object: 'payment_intent', status: 'succeeded', amount: 1000, currency: 'usd' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_visa' },
        'test',
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer sk_test_123');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      // Body must be form-encoded, not JSON — a JSON body is what the
      // previous version of this adapter incorrectly sent.
      expect(() => JSON.parse(opts.body)).toThrow();
      const params = new URLSearchParams(opts.body);
      expect(params.get('amount')).toBe('1000');
      expect(params.get('currency')).toBe('usd');
      expect(params.get('payment_method')).toBe('pm_card_visa');
      expect(params.get('confirm')).toBe('true');
      expect(params.get('metadata[appId]')).toBe('app1');

      expect(event.status).toBe('success');
      expect(event.id).toBe('pi_abc123');
    });

    it('reports failure (not success) when the PaymentIntent status is requires_payment_method', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'pi_declined',
            object: 'payment_intent',
            status: 'requires_payment_method',
            last_payment_error: { message: 'Your card was declined.' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_declined' },
        'test',
      );

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Your card was declined.');
    });

    it('reports an unresolved outcome (unknown, not failed) when the PaymentIntent is still processing', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'pi_processing', object: 'payment_intent', status: 'processing' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_ach_debit' },
        'test',
      );

      expect(event.status).toBe('unknown');
    });

    it('parses Stripe\'s documented error envelope on a non-2xx response', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: 'invalid_request_error', code: 'parameter_missing', message: 'Missing required param: currency.' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_visa' },
        'test',
      );

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Missing required param: currency.');
    });

    it('retries on 5xx (via BaseProvider.http_request) and eventually reports failure if every attempt fails', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Internal error' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_visa' },
        'test',
      );

      // This adapter caps Stripe calls at 2 attempts (Stripe handles its
      // own internal retries) — assert it used more than one, not the
      // default-3 count other adapters use.
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(event.status).toBe('failed');
    }, 15_000);

    it('reports offline/maintenance status without making an HTTP call', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new StripeProvider(makeConfig({ status: 'offline' }));
      await expect(
        provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_visa' }, 'test'),
      ).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
