import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { CheckoutComProvider } from './checkout';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'checkout',
    name: 'Checkout.com',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 1.8,
    transactionFeeFlat: 0.10,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('CheckoutComProvider', () => {
  const originalSecretKey = process.env.CHECKOUT_SECRET_KEY;
  const originalClientId = process.env.CHECKOUT_CLIENT_ID;
  const originalWebhookKey = process.env.CHECKOUT_WEBHOOK_SIGNING_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSecretKey === undefined) delete process.env.CHECKOUT_SECRET_KEY; else process.env.CHECKOUT_SECRET_KEY = originalSecretKey;
    if (originalClientId === undefined) delete process.env.CHECKOUT_CLIENT_ID; else process.env.CHECKOUT_CLIENT_ID = originalClientId;
    if (originalWebhookKey === undefined) delete process.env.CHECKOUT_WEBHOOK_SIGNING_KEY; else process.env.CHECKOUT_WEBHOOK_SIGNING_KEY = originalWebhookKey;
  });

  describe('isConfigured()', () => {
    it('requires both a secret key and a client id', () => {
      delete process.env.CHECKOUT_SECRET_KEY;
      delete process.env.CHECKOUT_CLIENT_ID;
      const provider = new CheckoutComProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      expect(provider.isConfigured()).toBe(false);

      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.CHECKOUT_SECRET_KEY;
      delete process.env.CHECKOUT_CLIENT_ID;
      const provider = new CheckoutComProvider(makeConfig());
      provider.setSecrets({ secret_key: 'sk_sbox_abc', client_id: 'cli_vkuhvk4vjn2edkps7dfsq6emqm' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('MSSD base URL derivation', () => {
    it('derives the sandbox subdomain from the first 8 chars of the client id (cli_ prefix stripped)', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1', status: 'Authorized' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig({ environment: 'test' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://vkuhvk4v.api.sandbox.checkout.com/payments');
    });

    it('uses the live host for a live environment config', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_live_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1', status: 'Authorized' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig({ environment: 'live' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://vkuhvk4v.api.checkout.com/payments');
    });
  });

  describe('without credentials/paymentToken (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.CHECKOUT_SECRET_KEY;
      delete process.env.CHECKOUT_CLIENT_ID;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^pay_sim_/);
    });

    it('falls back to simulated when configured but there is no paymentToken to charge', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with credentials and a paymentToken (real HTTP path)', () => {
    it('sends Bearer auth and a minor-units token-source charge body', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_abc123', status: 'Authorized', response_summary: 'Approved' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_abc' }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer sk_sbox_abc');
      const body = JSON.parse(opts.body);
      expect(body.source).toEqual({ type: 'token', token: 'tok_abc' });
      expect(body.amount).toBe(1000);
      expect(body.currency).toBe('USD');
      expect(body.capture).toBe(true);

      expect(event.status).toBe('success');
      expect(event.id).toBe('pay_abc123');
    });

    it('reports failed for a Declined result, with response_summary as the error', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1', status: 'Declined', response_summary: 'Insufficient funds' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toBe('Insufficient funds');
    });

    it('reports unknown (never fabricated) for a Pending result', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1', status: 'Pending' }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
      expect(event.status).toBe('unknown');
    });

    it('reports failed on a 422 error envelope, using the first error code as the message', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ request_id: 'req_1', error_type: 'request_invalid', error_codes: ['token_expired'] }, 422),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_1' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toBe('token_expired');
    });
  });

  describe('processRefund()', () => {
    it('returns a labeled simulated success with no credentials configured, never calling fetch', async () => {
      delete process.env.CHECKOUT_SECRET_KEY;
      delete process.env.CHECKOUT_CLIENT_ID;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const result = await provider.processRefund('pay_abc123', 10, 'USD');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.refundId).toMatch(/^checkout_refund_sim_/);
    });

    it("always reports 'unknown' (never a fabricated success) since refunds settle asynchronously via webhook", async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ action_id: 'act_1', reference: 'ref_1' }, 202));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const result = await provider.processRefund('pay_abc123', 10, 'USD');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://vkuhvk4v.api.sandbox.checkout.com/payments/pay_abc123/refunds');
      const body = JSON.parse(opts.body);
      expect(body.amount).toBe(1000);

      expect(result.status).toBe('unknown');
      expect(result.refundId).toBe('act_1');
    });

    it('reports failed on a non-2xx refund error', async () => {
      process.env.CHECKOUT_SECRET_KEY = 'sk_sbox_abc';
      process.env.CHECKOUT_CLIENT_ID = 'cli_vkuhvk4vjn2edkps7dfsq6emqm';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ request_id: 'req_1', error_type: 'request_invalid', error_codes: ['payment_not_found'] }, 404),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new CheckoutComProvider(makeConfig());
      const result = await provider.processRefund('pay_nonexistent', 10, 'USD');
      expect(result.status).toBe('failed');
      expect(result.error).toBe('payment_not_found');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null when no webhook signing key is configured', async () => {
      delete process.env.CHECKOUT_WEBHOOK_SIGNING_KEY;
      const provider = new CheckoutComProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', { 'cko-signature': 'anything' });
      expect(result).toBeNull();
    });

    it('returns true for a valid Cko-Signature (HMAC-SHA256 hex of the raw body)', async () => {
      process.env.CHECKOUT_WEBHOOK_SIGNING_KEY = 'my-signing-key';
      const provider = new CheckoutComProvider(makeConfig());
      const rawBody = '{"type":"payment_captured"}';
      const sig = createHmac('sha256', 'my-signing-key').update(rawBody, 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature(rawBody, { 'cko-signature': sig });
      expect(result).toBe(true);
    });

    it('returns false for a tampered body', async () => {
      process.env.CHECKOUT_WEBHOOK_SIGNING_KEY = 'my-signing-key';
      const provider = new CheckoutComProvider(makeConfig());
      const sig = createHmac('sha256', 'my-signing-key').update('{"type":"payment_captured"}', 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature('{"type":"tampered"}', { 'cko-signature': sig });
      expect(result).toBe(false);
    });

    it('returns false when the header is missing', async () => {
      process.env.CHECKOUT_WEBHOOK_SIGNING_KEY = 'my-signing-key';
      const provider = new CheckoutComProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBe(false);
    });
  });
});
