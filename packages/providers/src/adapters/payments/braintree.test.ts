import { describe, it, expect, afterEach, vi } from 'vitest';
import { BraintreeProvider } from './braintree';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'braintree',
    name: 'Braintree',
    category: 'payment',
    status: 'online',
    weight: 45,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 2.59,
    transactionFeeFlat: 0.49,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('BraintreeProvider', () => {
  const originalPublicKey = process.env.BRAINTREE_PUBLIC_KEY;
  const originalPrivateKey = process.env.BRAINTREE_PRIVATE_KEY;
  const originalMerchantId = process.env.BRAINTREE_MERCHANT_ID;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalPublicKey === undefined) delete process.env.BRAINTREE_PUBLIC_KEY; else process.env.BRAINTREE_PUBLIC_KEY = originalPublicKey;
    if (originalPrivateKey === undefined) delete process.env.BRAINTREE_PRIVATE_KEY; else process.env.BRAINTREE_PRIVATE_KEY = originalPrivateKey;
    if (originalMerchantId === undefined) delete process.env.BRAINTREE_MERCHANT_ID; else process.env.BRAINTREE_MERCHANT_ID = originalMerchantId;
  });

  describe('isConfigured()', () => {
    it('requires a public key, private key, and merchant id', () => {
      delete process.env.BRAINTREE_PUBLIC_KEY;
      delete process.env.BRAINTREE_PRIVATE_KEY;
      delete process.env.BRAINTREE_MERCHANT_ID;
      const provider = new BraintreeProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      expect(provider.isConfigured()).toBe(false);

      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      expect(provider.isConfigured()).toBe(false);

      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.BRAINTREE_PUBLIC_KEY;
      delete process.env.BRAINTREE_PRIVATE_KEY;
      delete process.env.BRAINTREE_MERCHANT_ID;
      const provider = new BraintreeProvider(makeConfig());
      provider.setSecrets({ public_key: 'pub_1', private_key: 'priv_1', merchant_id: 'merchant_1' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('base URL selection by environment', () => {
    it('calls the sandbox GraphQL endpoint for a test environment config', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { chargeCreditCard: { transaction: { id: 'txn_1', status: 'SETTLED', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig({ environment: 'test' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'fake-valid-nonce' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://payments.sandbox.braintree-api.com/graphql');
    });

    it('calls the live GraphQL endpoint for a live environment config', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { chargeCreditCard: { transaction: { id: 'txn_1', status: 'SETTLED', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig({ environment: 'live' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'real-nonce' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://payments.braintree-api.com/graphql');
    });
  });

  describe('without credentials/paymentToken (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.BRAINTREE_PUBLIC_KEY;
      delete process.env.BRAINTREE_PRIVATE_KEY;
      delete process.env.BRAINTREE_MERCHANT_ID;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^braintree_sim_/);
    });

    it('falls back to simulated when configured but there is no paymentToken to charge', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with credentials and a paymentToken (real HTTP path)', () => {
    it('sends Basic auth, Braintree-Version header, and a decimal-string amount body', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { chargeCreditCard: { transaction: { id: 'txn_abc123', status: 'SETTLED', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'fake-valid-nonce' }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Basic ' + Buffer.from('pub_1:priv_1').toString('base64'));
      expect(opts.headers['Braintree-Version']).toBe('2019-01-01');
      const body = JSON.parse(opts.body);
      expect(body.variables.input.paymentMethodId).toBe('fake-valid-nonce');
      expect(body.variables.input.transaction.amount).toBe('10.00');

      expect(event.status).toBe('success');
      expect(event.id).toBe('txn_abc123');
      expect(event.amount).toBe(10);
      expect(event.currency).toBe('USD');
    });

    it.each(['AUTHORIZED', 'SUBMITTED_FOR_SETTLEMENT', 'SETTLING', 'SETTLED'])(
      'reports success for charge status %s',
      async (status) => {
        process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
        process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
        process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
        const fetchSpy = vi.fn().mockResolvedValue(
          jsonResponse({ data: { chargeCreditCard: { transaction: { id: 'txn_1', status, amount: { value: '10.00', currencyCode: 'USD' } } } } }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const provider = new BraintreeProvider(makeConfig());
        const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
        expect(event.status).toBe('success');
      },
    );

    it.each(['PROCESSOR_DECLINED', 'GATEWAY_REJECTED', 'FAILED', 'VOIDED'])(
      'reports failed for charge status %s',
      async (status) => {
        process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
        process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
        process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
        const fetchSpy = vi.fn().mockResolvedValue(
          jsonResponse({ data: { chargeCreditCard: { transaction: { id: 'txn_1', status, amount: { value: '10.00', currencyCode: 'USD' } } } } }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const provider = new BraintreeProvider(makeConfig());
        const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
        expect(event.status).toBe('failed');
        expect(event.error).toContain(status);
      },
    );

    it('reports unknown (never fabricated) for an unrecognized status', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { chargeCreditCard: { transaction: { id: 'txn_1', status: 'SOME_NEW_STATUS', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
      expect(event.status).toBe('unknown');
    });

    it('reports failed when the GraphQL response carries an errors array', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: null, errors: [{ message: 'Payment method nonce is required.' }] }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toBe('Payment method nonce is required.');
    });

    it('reports failed on a non-2xx HTTP error with no errors envelope', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}, 401));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
      expect(event.status).toBe('failed');
    });
  });

  describe('processRefund()', () => {
    it('returns a labeled simulated success with no credentials configured, never calling fetch', async () => {
      delete process.env.BRAINTREE_PUBLIC_KEY;
      delete process.env.BRAINTREE_PRIVATE_KEY;
      delete process.env.BRAINTREE_MERCHANT_ID;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const result = await provider.processRefund('txn_abc123', 10, 'USD');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.refundId).toMatch(/^braintree_refund_sim_/);
    });

    it('reports success only for a SETTLED refund status', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { refundTransaction: { refund: { id: 'refund_1', status: 'SETTLED', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const result = await provider.processRefund('txn_abc123', 10, 'USD');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://payments.sandbox.braintree-api.com/graphql');
      const body = JSON.parse(opts.body);
      expect(body.variables.input.transactionId).toBe('txn_abc123');
      expect(body.variables.input.refund.amount).toBe('10.00');

      expect(result.status).toBe('success');
      expect(result.refundId).toBe('refund_1');
    });

    it("reports 'unknown' (never a fabricated success) for a SUBMITTED_FOR_SETTLEMENT refund status", async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { refundTransaction: { refund: { id: 'refund_1', status: 'SUBMITTED_FOR_SETTLEMENT', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const result = await provider.processRefund('txn_abc123', 10, 'USD');
      expect(result.status).toBe('unknown');
    });

    it('reports failed for a declined/rejected refund status', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { refundTransaction: { refund: { id: 'refund_1', status: 'PROCESSOR_DECLINED', amount: { value: '10.00', currencyCode: 'USD' } } } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const result = await provider.processRefund('txn_abc123', 10, 'USD');
      expect(result.status).toBe('failed');
    });

    it('reports failed when the refund GraphQL response carries an errors array', async () => {
      process.env.BRAINTREE_PUBLIC_KEY = 'pub_1';
      process.env.BRAINTREE_PRIVATE_KEY = 'priv_1';
      process.env.BRAINTREE_MERCHANT_ID = 'merchant_1';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: null, errors: [{ message: 'Transaction has already been refunded.' }] }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new BraintreeProvider(makeConfig());
      const result = await provider.processRefund('txn_abc123', 10, 'USD');
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Transaction has already been refunded.');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null — native Braintree webhook verification is not implemented', async () => {
      const provider = new BraintreeProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBeNull();
    });
  });
});
