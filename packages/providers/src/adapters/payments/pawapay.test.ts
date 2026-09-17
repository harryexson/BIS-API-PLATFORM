import { describe, it, expect, afterEach, vi } from 'vitest';
import { PawaPayProvider } from './pawapay';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'pawapay',
    name: 'PawaPay',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 1.0,
    ...overrides,
  };
}

describe('PawaPayProvider', () => {
  const originalApiKey = process.env.PAWAPAY_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.PAWAPAY_API_KEY;
    else process.env.PAWAPAY_API_KEY = originalApiKey;
  });

  describe('isConfigured()', () => {
    it('is false with no credentials, true once set via env or setSecrets()', () => {
      delete process.env.PAWAPAY_API_KEY;
      const provider = new PawaPayProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.PAWAPAY_API_KEY = 'test-key';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.PAWAPAY_API_KEY;
      provider.setSecrets({ api_key: 'from_admin' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null (no native RFC-9421 scheme implemented — see BaseProvider default and the comment in pawapay.ts) so the gateway falls back to the generic platform HMAC check', async () => {
      const provider = new PawaPayProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBeNull();
    });
  });

  describe('without an API key configured (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.PAWAPAY_API_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 100, currency: 'KES', paymentMethod: 'mobile_money', phoneNumber: '254700000000' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.depositId).toMatch(/^paw-/);
    });
  });

  describe('with an API key but no pawapayProvider code', () => {
    it('falls back to simulated rather than guessing an operator+country code', async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 100, currency: 'KES', paymentMethod: 'mobile_money', phoneNumber: '254700000000' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with an API key and a provider code (real HTTP path)', () => {
    const validPayload = {
      amount: 100,
      currency: 'ZMW',
      paymentMethod: 'mobile_money',
      phoneNumber: '260971234567',
      metadata: { pawapayProvider: 'MTN_MOMO_ZMB' },
    };

    it('sends a JSON body to POST /v2/deposits with Bearer auth and the MMO payer shape', async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ depositId: 'dep-1', status: 'ACCEPTED', created: '2026-09-15T00:00:00Z' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.pawapay.io/v2/deposits');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('Bearer test-key');
      const body = JSON.parse(opts.body);
      expect(body.amount).toBe('100.00');
      expect(body.currency).toBe('ZMW');
      expect(body.payer.type).toBe('MMO');
      expect(body.payer.accountDetails.phoneNumber).toBe('260971234567');
      expect(body.payer.accountDetails.provider).toBe('MTN_MOMO_ZMB');

      // ACCEPTED means the request was queued, not that the customer has
      // approved it yet — this is genuinely unresolved, not a success.
      expect(event.status).toBe('unknown');
      expect(event.id).toBe('dep-1');
    });

    it('reports failure (not unknown) when PawaPay rejects the request outright', async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            depositId: 'dep-2',
            status: 'REJECTED',
            failureReason: { failureCode: 'PROVIDER_TEMPORARILY_UNAVAILABLE', failureMessage: "The provider 'MTN_MOMO_ZMB' is currently not able to process payments." },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe("The provider 'MTN_MOMO_ZMB' is currently not able to process payments.");
    });

    it('treats a duplicate-request response as unresolved rather than assuming the original outcome', async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ depositId: 'dep-3', status: 'DUPLICATE_IGNORED' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('unknown');
    });

    it("parses PawaPay's documented error envelope on a non-2xx response", async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ failureReason: { failureCode: 'INVALID_INPUT', failureMessage: 'Invalid currency for this provider' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid currency for this provider');
    });

    it('retries on 5xx (via BaseProvider.http_request) and eventually reports failure if every attempt fails', async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Internal error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig());
      const event = await provider.processRequest('app1', validPayload, 'test');

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(event.status).toBe('failed');
    }, 15_000);

    it('reports offline/maintenance status without making an HTTP call', async () => {
      process.env.PAWAPAY_API_KEY = 'test-key';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PawaPayProvider(makeConfig({ status: 'offline' }));
      await expect(provider.processRequest('app1', validPayload, 'test')).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
