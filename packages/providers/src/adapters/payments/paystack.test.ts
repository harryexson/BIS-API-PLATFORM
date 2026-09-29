import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { PaystackProvider } from './paystack';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'paystack',
    name: 'Paystack',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 1.5,
    transactionFeeFlat: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('PaystackProvider', () => {
  const originalKey = process.env.PAYSTACK_SECRET_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = originalKey;
  });

  describe('isConfigured()', () => {
    it('is false with no credentials, true once set via env or setSecrets()', () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      const provider = new PaystackProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.PAYSTACK_SECRET_KEY;
      provider.setSecrets({ api_key: 'sk_test_from_console' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without credentials/paymentToken/email (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'NGN', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^paystack_sim_/);
    });

    it('falls back to simulated when configured with a paymentToken but no email', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'NGN', paymentMethod: 'card', paymentToken: 'AUTH_abc123' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with credentials, a paymentToken, and an email (real HTTP path)', () => {
    it('sends Bearer auth and the authorization_code/email/amount-in-kobo body to charge_authorization', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: true, message: 'Charge attempted', data: { status: 'success', reference: 'ref_abc123', amount: 1000, currency: 'NGN', gateway_response: 'Approved' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        amount: 10, currency: 'NGN', paymentMethod: 'card', paymentToken: 'AUTH_abc123',
        metadata: { email: 'donor@example.com' },
      }, 'test');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.paystack.co/transaction/charge_authorization');
      expect(opts.headers.Authorization).toBe('Bearer sk_test_abc');
      const body = JSON.parse(opts.body);
      expect(body.authorization_code).toBe('AUTH_abc123');
      expect(body.email).toBe('donor@example.com');
      expect(body.amount).toBe(1000);

      expect(event.status).toBe('success');
      expect(event.id).toBe('ref_abc123');
    });

    it('reports failed for data.status "failed", using gateway_response as the error', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: true, data: { status: 'failed', reference: 'ref_1', gateway_response: 'Insufficient Funds' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        amount: 10, currency: 'NGN', paymentMethod: 'card', paymentToken: 'AUTH_abc123', metadata: { email: 'donor@example.com' },
      }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Insufficient Funds');
    });

    it('reports unknown (never fabricated) for data.status "abandoned"', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: true, data: { status: 'abandoned', reference: 'ref_1' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        amount: 10, currency: 'NGN', paymentMethod: 'card', paymentToken: 'AUTH_abc123', metadata: { email: 'donor@example.com' },
      }, 'test');

      expect(event.status).toBe('unknown');
    });

    it('reports failed when the top-level status is false, using the message field', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: false, message: 'Invalid authorization code' }, 400),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        amount: 10, currency: 'NGN', paymentMethod: 'card', paymentToken: 'AUTH_bad', metadata: { email: 'donor@example.com' },
      }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid authorization code');
    });
  });

  describe('processRefund()', () => {
    it('returns a labeled simulated success with no credentials configured, never calling fetch', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const result = await provider.processRefund('ref_abc123', 10, 'NGN');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.refundId).toMatch(/^paystack_refund_sim_/);
    });

    it('reports success only for refund status "processed"', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: true, data: { id: 12345, status: 'processed', amount: 1000, currency: 'NGN' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const result = await provider.processRefund('ref_abc123', 10, 'NGN');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.paystack.co/refund');
      const body = JSON.parse(opts.body);
      expect(body.transaction).toBe('ref_abc123');

      expect(result.status).toBe('success');
    });

    it("reports 'unknown' (never a fabricated success) for refund status \"pending\"", async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: true, data: { id: 1, status: 'pending', amount: 1000, currency: 'NGN' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const result = await provider.processRefund('ref_abc123', 10, 'NGN');
      expect(result.status).toBe('unknown');
    });

    it('reports failed on an API-level error', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ status: false, message: 'Transaction reference not found' }, 404),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new PaystackProvider(makeConfig());
      const result = await provider.processRefund('ref_nonexistent', 10, 'NGN');
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Transaction reference not found');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null when no API key is configured', async () => {
      delete process.env.PAYSTACK_SECRET_KEY;
      const provider = new PaystackProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', { 'x-paystack-signature': 'anything' });
      expect(result).toBeNull();
    });

    it('returns true for a valid HMAC-SHA512 signature (bare hex, keyed by the API secret key)', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const provider = new PaystackProvider(makeConfig());
      const rawBody = '{"event":"charge.success"}';
      const sig = createHmac('sha512', 'sk_test_abc').update(rawBody, 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature(rawBody, { 'x-paystack-signature': sig });
      expect(result).toBe(true);
    });

    it('returns false for a tampered body', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const provider = new PaystackProvider(makeConfig());
      const sig = createHmac('sha512', 'sk_test_abc').update('{"event":"charge.success"}', 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature('{"event":"tampered"}', { 'x-paystack-signature': sig });
      expect(result).toBe(false);
    });

    it('returns false when the header is missing', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_abc';
      const provider = new PaystackProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBe(false);
    });
  });
});
