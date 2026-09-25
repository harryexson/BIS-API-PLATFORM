import { describe, it, expect, afterEach, vi } from 'vitest';
import { AdyenProvider } from './adyen';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'adyen',
    name: 'Adyen',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 1.9,
    transactionFeeFlat: 0.12,
    ...overrides,
  };
}

describe('AdyenProvider', () => {
  const originalApiKey = process.env.ADYEN_API_KEY;
  const originalMerchant = process.env.ADYEN_MERCHANT_ACCOUNT;
  const originalPrefix = process.env.ADYEN_LIVE_URL_PREFIX;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.ADYEN_API_KEY; else process.env.ADYEN_API_KEY = originalApiKey;
    if (originalMerchant === undefined) delete process.env.ADYEN_MERCHANT_ACCOUNT; else process.env.ADYEN_MERCHANT_ACCOUNT = originalMerchant;
    if (originalPrefix === undefined) delete process.env.ADYEN_LIVE_URL_PREFIX; else process.env.ADYEN_LIVE_URL_PREFIX = originalPrefix;
  });

  describe('isConfigured()', () => {
    it('requires both an API key and a merchant account', () => {
      delete process.env.ADYEN_API_KEY;
      delete process.env.ADYEN_MERCHANT_ACCOUNT;
      const provider = new AdyenProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.ADYEN_API_KEY = 'AQE...';
      expect(provider.isConfigured()).toBe(false);

      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.ADYEN_API_KEY;
      delete process.env.ADYEN_MERCHANT_ACCOUNT;
      const provider = new AdyenProvider(makeConfig());
      provider.setSecrets({ api_key: 'AQE...', merchant_account: 'BisApiPlatformECOM' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without a live_url_prefix configured', () => {
    it('calls the real Adyen test host, not a fabricated live one', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      delete process.env.ADYEN_LIVE_URL_PREFIX;
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'psp1', resultCode: 'Authorised' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_1' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://checkout-test.adyen.com/v71/payments');
    });
  });

  describe('with a live_url_prefix configured', () => {
    it('calls the prefixed live host', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      process.env.ADYEN_LIVE_URL_PREFIX = 'reachchurch1234';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'psp1', resultCode: 'Authorised' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_1' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://reachchurch1234-checkout-live.adyenpayments.com/checkout/v71/payments');
    });
  });

  describe('without an API key/merchant account/paymentToken (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.ADYEN_API_KEY;
      delete process.env.ADYEN_MERCHANT_ACCOUNT;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.pspReference).toMatch(/^adyen_sim_/);
    });

    it('falls back to simulated when configured but there is no paymentToken to charge', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with API key, merchant account, and a paymentToken (real HTTP path)', () => {
    it('sends X-API-Key auth and a storedPaymentMethodId charge body', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'psp_abc123', resultCode: 'Authorised' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_method_1',
        metadata: { shopperReference: 'donor_42' },
      }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers['X-API-Key']).toBe('AQE...');
      const body = JSON.parse(opts.body);
      expect(body.merchantAccount).toBe('BisApiPlatformECOM');
      expect(body.amount).toEqual({ value: 1000, currency: 'USD' });
      expect(body.paymentMethod).toEqual({ type: 'scheme', storedPaymentMethodId: 'stored_method_1' });
      expect(body.shopperReference).toBe('donor_42');
      expect(body.shopperInteraction).toBe('ContAuth');

      expect(event.status).toBe('success');
      expect(event.id).toBe('psp_abc123');
    });

    it('falls back to appId as shopperReference when metadata carries none', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'psp1', resultCode: 'Authorised' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      await provider.processRequest('reach-church', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_1' }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.shopperReference).toBe('reach-church');
    });

    it('reports failed for a Refused result, with refusalReason as the error', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'psp1', resultCode: 'Refused', refusalReason: 'Insufficient funds' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_1' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toBe('Insufficient funds');
    });

    it('reports unknown (never fabricated) for a Pending result', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'psp1', resultCode: 'Pending' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_1' }, 'test');
      expect(event.status).toBe('unknown');
    });

    it('reports failed on a non-2xx error envelope', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 403, errorCode: '901', message: 'Not allowed', errorType: 'security' }), { status: 403, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_1' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toBe('Not allowed');
    });
  });

  describe('processRefund()', () => {
    it('returns a labeled simulated success with no credentials configured, never calling fetch', async () => {
      delete process.env.ADYEN_API_KEY;
      delete process.env.ADYEN_MERCHANT_ACCOUNT;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const result = await provider.processRefund('psp_abc123', 10, 'USD');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.refundId).toMatch(/^adyen_refund_sim_/);
    });

    it("always reports 'unknown' (never a fabricated success) since Adyen refunds settle asynchronously", async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ pspReference: 'refund_psp_1', status: 'received' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const result = await provider.processRefund('psp_abc123', 10, 'USD');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://checkout-test.adyen.com/v71/payments/psp_abc123/refunds');
      const body = JSON.parse(opts.body);
      expect(body.amount).toEqual({ value: 1000, currency: 'USD' });

      expect(result.status).toBe('unknown');
      expect(result.refundId).toBe('refund_psp_1');
    });

    it('reports failed on a non-2xx refund error', async () => {
      process.env.ADYEN_API_KEY = 'AQE...';
      process.env.ADYEN_MERCHANT_ACCOUNT = 'BisApiPlatformECOM';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Original pspReference not found' }), { status: 422, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AdyenProvider(makeConfig());
      const result = await provider.processRefund('psp_nonexistent', 10, 'USD');
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Original pspReference not found');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null — native Adyen webhook verification is deliberately not implemented', async () => {
      const provider = new AdyenProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBeNull();
    });
  });
});
