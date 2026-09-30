import { describe, it, expect, afterEach, vi } from 'vitest';
import { PayPalProvider } from './paypal';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'paypal',
    name: 'PayPal',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 3.49,
    transactionFeeFlat: 0.49,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const TOKEN_RESPONSE = { access_token: 'A21AA_token', token_type: 'Bearer', expires_in: 32400 };

describe('PayPalProvider', () => {
  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClientId === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.PAYPAL_CLIENT_SECRET; else process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
  });

  describe('isConfigured()', () => {
    it('requires both a client id and a client secret', () => {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      const provider = new PayPalProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.PAYPAL_CLIENT_ID = 'client_1';
      expect(provider.isConfigured()).toBe(false);

      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      const provider = new PayPalProvider(makeConfig());
      provider.setSecrets({ client_id: 'client_1', client_secret: 'secret_1' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('base URL selection by environment', () => {
    it('calls the sandbox host for a test/non-live environment config', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({
          id: 'order_1', status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'cap_1', status: 'COMPLETED' }] } }],
        }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig({ environment: 'test' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');

      expect(fetchSpy.mock.calls[0][0]).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
      expect(fetchSpy.mock.calls[1][0]).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    });

    it('calls the live host for a live environment config', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({
          id: 'order_1', status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'cap_1', status: 'COMPLETED' }] } }],
        }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig({ environment: 'live' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');

      expect(fetchSpy.mock.calls[0][0]).toBe('https://api-m.paypal.com/v1/oauth2/token');
      expect(fetchSpy.mock.calls[1][0]).toBe('https://api-m.paypal.com/v2/checkout/orders');
    });
  });

  describe('without credentials/paymentToken (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^paypal_sim_/);
    });

    it('falls back to simulated when configured but there is no paymentToken (vault_id) to charge', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with credentials and a paymentToken (real HTTP path)', () => {
    it('authenticates via OAuth2 client credentials, then creates+captures an order against the vaulted instrument', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({
          id: 'order_abc', status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'cap_abc123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } }] } }],
        }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_abc' }, 'test');

      const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[0];
      expect(tokenUrl).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
      expect(tokenOpts.headers.Authorization).toBe('Basic ' + Buffer.from('client_1:secret_1').toString('base64'));
      expect(tokenOpts.body).toBe('grant_type=client_credentials');

      const [, orderOpts] = fetchSpy.mock.calls[1];
      expect(orderOpts.headers.Authorization).toBe('Bearer A21AA_token');
      const body = JSON.parse(orderOpts.body);
      expect(body.intent).toBe('CAPTURE');
      expect(body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '10.00' });
      expect(body.payment_source.paypal.vault_id).toBe('vault_abc');

      // The capture id, not the order id, is used as this platform's
      // transaction id — a refund needs the capture id specifically.
      expect(event.id).toBe('cap_abc123');
      expect(event.status).toBe('success');
    });

    it('reuses a cached OAuth token across multiple requests instead of re-authenticating every time', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({
          id: 'order_1', status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'cap_1', status: 'COMPLETED' }] } }],
        }))
        .mockResolvedValueOnce(jsonResponse({
          id: 'order_2', status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'cap_2', status: 'COMPLETED' }] } }],
        }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');

      // 1 token call + 2 order calls = 3, not 4 (no second token call).
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('reports failed for a VOIDED order', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({ id: 'order_1', status: 'VOIDED' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');
      expect(event.status).toBe('failed');
    });

    it('reports unknown (never fabricated) for PAYER_ACTION_REQUIRED', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({ id: 'order_1', status: 'PAYER_ACTION_REQUIRED' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');
      expect(event.status).toBe('unknown');
    });

    it('reports failed on a non-2xx error envelope', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({ name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', debug_id: 'abc123' }, 404));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_bad' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toContain('does not exist');
    });

    it('reports failed when OAuth authentication itself fails', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'wrong_secret';
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        jsonResponse({ error: 'invalid_client', error_description: 'Client Authentication failed' }, 401),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toContain('Client Authentication failed');
    });
  });

  describe('refund()', () => {
    it('returns a labeled simulated success with no credentials configured, never calling fetch', async () => {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const result = await provider.refund('app1', { originalTransactionId: 'cap_abc123', amount: 10, currency: 'USD' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.id).toMatch(/^re_/);
    });

    it('refunds against the capture id (not an order id) and reports success for a COMPLETED refund', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({ id: 'refund_1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } }, 201));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const result = await provider.refund('app1', { originalTransactionId: 'cap_abc123', amount: 10, currency: 'USD' }, 'test');

      const [url] = fetchSpy.mock.calls[1];
      expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/cap_abc123/refund');

      expect(result.status).toBe('success');
      expect(result.id).toBe('refund_1');
    });

    it('reports failed on a non-2xx refund error', async () => {
      process.env.PAYPAL_CLIENT_ID = 'client_1';
      process.env.PAYPAL_CLIENT_SECRET = 'secret_1';
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({ name: 'UNPROCESSABLE_ENTITY', message: 'Refund amount exceeds captured amount.' }, 422));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PayPalProvider(makeConfig());
      const result = await provider.refund('app1', { originalTransactionId: 'cap_abc123', amount: 999, currency: 'USD' }, 'test');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('exceeds captured amount');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null — native PayPal webhook verification is deliberately not implemented', async () => {
      const provider = new PayPalProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBeNull();
    });
  });
});
