import { describe, it, expect, afterEach, vi } from 'vitest';
import { NMIProvider } from './nmi';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'nmi',
    name: 'NMI',
    category: 'payment',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    transactionFeePercent: 2.2,
    transactionFeeFlat: 0.2,
    ...overrides,
  };
}

function formResponse(fields: Record<string, string>, status = 200): Response {
  const body = new URLSearchParams(fields).toString();
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

describe('NMIProvider', () => {
  const originalApiKey = process.env.NMI_API_KEY;
  const originalGatewayId = process.env.NMI_GATEWAY_ID;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.NMI_API_KEY;
    else process.env.NMI_API_KEY = originalApiKey;
    if (originalGatewayId === undefined) delete process.env.NMI_GATEWAY_ID;
    else process.env.NMI_GATEWAY_ID = originalGatewayId;
  });

  describe('isConfigured()', () => {
    it('depends only on the API key — gateway_id has a working default', () => {
      delete process.env.NMI_API_KEY;
      delete process.env.NMI_GATEWAY_ID;
      const provider = new NMIProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.NMI_API_KEY = 'test-key';
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    const originalSigningKey = process.env.NMI_WEBHOOK_SIGNING_KEY;
    afterEach(() => {
      if (originalSigningKey === undefined) delete process.env.NMI_WEBHOOK_SIGNING_KEY;
      else process.env.NMI_WEBHOOK_SIGNING_KEY = originalSigningKey;
    });

    it('returns null when no signing key is configured', async () => {
      delete process.env.NMI_WEBHOOK_SIGNING_KEY;
      const provider = new NMIProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', { 'webhook-signature': 't=nonce,s=deadbeef' });
      expect(result).toBeNull();
    });

    it('returns true for a correctly computed t=/s= signature (t is a nonce, not a timestamp)', async () => {
      process.env.NMI_WEBHOOK_SIGNING_KEY = 'signing-key';
      const provider = new NMIProvider(makeConfig());
      const rawBody = '{"event":"transaction.sale.success"}';
      const nonce = 'abc123';
      const { createHmac } = await import('crypto');
      const sig = createHmac('sha256', 'signing-key').update(`${nonce}.${rawBody}`, 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature(rawBody, {
        'webhook-signature': `t=${nonce},s=${sig}`,
      });
      expect(result).toBe(true);
    });

    it('returns false for a tampered body', async () => {
      process.env.NMI_WEBHOOK_SIGNING_KEY = 'signing-key';
      const provider = new NMIProvider(makeConfig());
      const nonce = 'abc123';
      const { createHmac } = await import('crypto');
      const sig = createHmac('sha256', 'signing-key').update(`${nonce}.{"event":"original"}`, 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature('{"event":"tampered"}', {
        'webhook-signature': `t=${nonce},s=${sig}`,
      });
      expect(result).toBe(false);
    });

    it('returns false when the header is missing', async () => {
      process.env.NMI_WEBHOOK_SIGNING_KEY = 'signing-key';
      const provider = new NMIProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBe(false);
    });
  });

  describe('without an API key configured (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.NMI_API_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.transactionid).toMatch(/^nmi_/);
    });
  });

  describe('with an API key but no paymentToken (no instrument to charge)', () => {
    it('falls back to simulated rather than calling NMI with nothing to charge', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with an API key and a paymentToken (real HTTP path)', () => {
    it('sends a form-urlencoded body to the default secure.nmi.com host and parses a form-urlencoded (not JSON) response', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      delete process.env.NMI_GATEWAY_ID;
      const fetchSpy = vi.fn().mockResolvedValue(
        formResponse({ response: '1', responsetext: 'SUCCESS', authcode: '123456', transactionid: 'txn-1' }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_abc123' },
        'test',
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://secure.nmi.com/api/transact.php');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(() => JSON.parse(opts.body)).toThrow();
      const sentParams = new URLSearchParams(opts.body);
      expect(sentParams.get('security_key')).toBe('test-security-key');
      expect(sentParams.get('type')).toBe('sale');
      expect(sentParams.get('amount')).toBe('10.00');
      expect(sentParams.get('payment_token')).toBe('tok_abc123');

      expect(event.status).toBe('success');
      expect(event.id).toBe('txn-1');
      expect(event.response.authcode).toBe('123456');
    });

    it('honors a custom NMI_GATEWAY_ID as the request hostname', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      process.env.NMI_GATEWAY_ID = 'reseller.example.com';
      const fetchSpy = vi.fn().mockResolvedValue(
        formResponse({ response: '1', responsetext: 'SUCCESS', transactionid: 'txn-2' }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_abc123' },
        'test',
      );

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://reseller.example.com/api/transact.php');
    });

    it('reports failure (not fabricated success) when NMI declines the transaction (response=2)', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        formResponse({ response: '2', responsetext: 'DECLINE', transactionid: 'txn-3' }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_declined' },
        'test',
      );

      expect(event.status).toBe('failed');
      expect(event.error).toBe('DECLINE');
      expect(event.cost).toBe(0);
    });

    it('reports failure when NMI returns a system/data error (response=3)', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      const fetchSpy = vi.fn().mockResolvedValue(
        formResponse({ response: '3', responsetext: 'Invalid Credit Card Number', transactionid: '0' }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_bad' },
        'test',
      );

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid Credit Card Number');
    });

    it('does not fabricate an outcome when the response has no response field', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_abc123' },
        'test',
      );

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/did not include a 'response' field/);
    });

    it('retries on 5xx (via BaseProvider.http_request) and eventually reports failure if every attempt fails', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      const fetchSpy = vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_abc123' },
        'test',
      );

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(event.status).toBe('failed');
    }, 15_000);

    it('reports offline/maintenance status without making an HTTP call', async () => {
      process.env.NMI_API_KEY = 'test-security-key';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new NMIProvider(makeConfig({ status: 'offline' }));
      await expect(
        provider.processRequest('app1', { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_abc123' }, 'test'),
      ).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
