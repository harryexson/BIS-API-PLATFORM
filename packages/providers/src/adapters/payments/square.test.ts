import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { SquareProvider } from './square';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'square',
    name: 'Square',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 2.6,
    transactionFeeFlat: 0.10,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('SquareProvider', () => {
  const originalToken = process.env.SQUARE_ACCESS_TOKEN;
  const originalLocation = process.env.SQUARE_LOCATION_ID;
  const originalWebhookKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const originalWebhookUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.SQUARE_ACCESS_TOKEN; else process.env.SQUARE_ACCESS_TOKEN = originalToken;
    if (originalLocation === undefined) delete process.env.SQUARE_LOCATION_ID; else process.env.SQUARE_LOCATION_ID = originalLocation;
    if (originalWebhookKey === undefined) delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY; else process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = originalWebhookKey;
    if (originalWebhookUrl === undefined) delete process.env.SQUARE_WEBHOOK_NOTIFICATION_URL; else process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = originalWebhookUrl;
  });

  describe('isConfigured()', () => {
    it('is false with no access token, true once set via env or setSecrets()', () => {
      delete process.env.SQUARE_ACCESS_TOKEN;
      const provider = new SquareProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.SQUARE_ACCESS_TOKEN;
      provider.setSecrets({ access_token: 'EAAA_from_console' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('base URL selection by environment', () => {
    it('calls the sandbox host for a non-live environment config', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ payment: { id: 'pay_1', status: 'COMPLETED' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig({ environment: 'test' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_1' }, 'test');

      expect(fetchSpy.mock.calls[0][0]).toBe('https://connect.squareupsandbox.com/v2/payments');
    });

    it('calls the live host for a live environment config', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ payment: { id: 'pay_1', status: 'COMPLETED' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig({ environment: 'live' }));
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_1' }, 'test');

      expect(fetchSpy.mock.calls[0][0]).toBe('https://connect.squareup.com/v2/payments');
    });
  });

  describe('without credentials/paymentToken (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.SQUARE_ACCESS_TOKEN;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^square_sim_/);
    });

    it('falls back to simulated when configured but there is no paymentToken to charge', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with credentials and a paymentToken (real HTTP path)', () => {
    it('sends Bearer auth, Square-Version header, and a minor-units source_id/customer_id body', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ payment: { id: 'pay_abc123', status: 'COMPLETED', amount_money: { amount: 1000, currency: 'USD' } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_visa',
        metadata: { squareCustomerId: 'cust_42' },
      }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer EAAA_token');
      expect(opts.headers['Square-Version']).toBeTruthy();
      const body = JSON.parse(opts.body);
      expect(body.source_id).toBe('cnon_visa');
      expect(body.customer_id).toBe('cust_42');
      expect(body.amount_money).toEqual({ amount: 1000, currency: 'USD' });
      expect(body.autocomplete).toBe(true);
      expect(body.idempotency_key).toBeTruthy();

      expect(event.status).toBe('success');
      expect(event.id).toBe('pay_abc123');
    });

    it('falls back to appId as customer_id when metadata carries none', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ payment: { id: 'pay_1', status: 'COMPLETED' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      await provider.processRequest('reach-church', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_1' }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.customer_id).toBe('reach-church');
    });

    it('includes location_id only when configured', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      process.env.SQUARE_LOCATION_ID = 'loc_1';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ payment: { id: 'pay_1', status: 'COMPLETED' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_1' }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.location_id).toBe('loc_1');
    });

    it('reports failed for a FAILED payment status', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ payment: { id: 'pay_1', status: 'FAILED' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_declined' }, 'test');
      expect(event.status).toBe('failed');
    });

    it('reports unknown (never fabricated) for an APPROVED (not-yet-captured) payment', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ payment: { id: 'pay_1', status: 'APPROVED' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_1' }, 'test');
      expect(event.status).toBe('unknown');
    });

    it('reports failed on a non-2xx error envelope, using errors[0].detail', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'INSUFFICIENT_FUNDS', detail: "Authorization error: 'INSUFFICIENT_FUNDS'" }] }, 402),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon_bad' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toContain('INSUFFICIENT_FUNDS');
    });
  });

  describe('processRefund()', () => {
    it('returns a labeled simulated success with no credentials configured, never calling fetch', async () => {
      delete process.env.SQUARE_ACCESS_TOKEN;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const result = await provider.processRefund('pay_abc123', 10, 'USD');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.status).toBe('success');
      expect(result.refundId).toMatch(/^square_refund_sim_/);
    });

    it('reports success for a COMPLETED refund', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ refund: { id: 'refund_1', status: 'COMPLETED', amount_money: { amount: 1000, currency: 'USD' } } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const result = await provider.processRefund('pay_abc123', 10, 'USD');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://connect.squareupsandbox.com/v2/refunds');
      const body = JSON.parse(opts.body);
      expect(body.payment_id).toBe('pay_abc123');
      expect(body.amount_money).toEqual({ amount: 1000, currency: 'USD' });

      expect(result.status).toBe('success');
      expect(result.refundId).toBe('refund_1');
    });

    it("reports 'unknown' (never a fabricated success) for a PENDING refund", async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ refund: { id: 'refund_1', status: 'PENDING' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const result = await provider.processRefund('pay_abc123', 10, 'USD');
      expect(result.status).toBe('unknown');
    });

    it('reports failed for a REJECTED refund', async () => {
      process.env.SQUARE_ACCESS_TOKEN = 'EAAA_token';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ refund: { id: 'refund_1', status: 'REJECTED' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SquareProvider(makeConfig());
      const result = await provider.processRefund('pay_abc123', 10, 'USD');
      expect(result.status).toBe('failed');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null when the signature key or notification URL is not configured', async () => {
      delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
      delete process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
      const provider = new SquareProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', { 'x-square-hmacsha256-signature': 'anything' });
      expect(result).toBeNull();
    });

    it('returns true for a valid signature over notification_url + raw_body', async () => {
      process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'signing-key';
      process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = 'https://example.com/v1/api/webhooks/square';
      const provider = new SquareProvider(makeConfig());
      const rawBody = '{"type":"payment.updated"}';
      const sig = createHmac('sha256', 'signing-key')
        .update('https://example.com/v1/api/webhooks/square' + rawBody, 'utf8')
        .digest('base64');

      const result = await provider.verifyProviderWebhookSignature(rawBody, { 'x-square-hmacsha256-signature': sig });
      expect(result).toBe(true);
    });

    it('returns false for a tampered body', async () => {
      process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'signing-key';
      process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = 'https://example.com/v1/api/webhooks/square';
      const provider = new SquareProvider(makeConfig());
      const sig = createHmac('sha256', 'signing-key')
        .update('https://example.com/v1/api/webhooks/square{"type":"payment.updated"}', 'utf8')
        .digest('base64');

      const result = await provider.verifyProviderWebhookSignature('{"type":"tampered"}', { 'x-square-hmacsha256-signature': sig });
      expect(result).toBe(false);
    });

    it('returns false when the header is missing', async () => {
      process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'signing-key';
      process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = 'https://example.com/v1/api/webhooks/square';
      const provider = new SquareProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBe(false);
    });
  });
});
