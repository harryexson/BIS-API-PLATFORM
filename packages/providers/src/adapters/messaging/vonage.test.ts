import { describe, it, expect, afterEach, vi } from 'vitest';
import { VonageProvider } from './vonage';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'vonage',
    name: 'Vonage',
    category: 'messaging',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.0067,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('VonageProvider', () => {
  const originalKey = process.env.VONAGE_API_KEY;
  const originalSecret = process.env.VONAGE_API_SECRET;
  const originalFrom = process.env.VONAGE_FROM_NUMBER;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.VONAGE_API_KEY; else process.env.VONAGE_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.VONAGE_API_SECRET; else process.env.VONAGE_API_SECRET = originalSecret;
    if (originalFrom === undefined) delete process.env.VONAGE_FROM_NUMBER; else process.env.VONAGE_FROM_NUMBER = originalFrom;
  });

  describe('isConfigured()', () => {
    it('requires an api key, api secret, and from-number', () => {
      delete process.env.VONAGE_API_KEY;
      delete process.env.VONAGE_API_SECRET;
      delete process.env.VONAGE_FROM_NUMBER;
      const provider = new VonageProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.VONAGE_API_KEY = 'key123';
      process.env.VONAGE_API_SECRET = 'secret123';
      expect(provider.isConfigured()).toBe(false);

      process.env.VONAGE_FROM_NUMBER = 'MyApp';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.VONAGE_API_KEY;
      delete process.env.VONAGE_API_SECRET;
      delete process.env.VONAGE_FROM_NUMBER;
      const provider = new VonageProvider(makeConfig());
      provider.setSecrets({ api_key: 'key123', api_secret: 'secret123', from_number: 'MyApp' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without credentials (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.VONAGE_API_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VonageProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.messageType).toBe('sms');
    });
  });

  describe('with credentials (real HTTP path)', () => {
    it('sends api_key/api_secret/to/from/text as a form-urlencoded body to /sms/json', async () => {
      process.env.VONAGE_API_KEY = 'key123';
      process.env.VONAGE_API_SECRET = 'secret123';
      process.env.VONAGE_FROM_NUMBER = 'MyApp';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          'message-count': '1',
          messages: [{ to: '15551234567', 'message-id': '0A0000000123ABCD', status: '0', 'remaining-balance': '9.9', 'message-price': '0.0067', network: '12345' }],
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VonageProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://rest.nexmo.com/sms/json');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(opts.body);
      expect(params.get('api_key')).toBe('key123');
      expect(params.get('api_secret')).toBe('secret123');
      expect(params.get('to')).toBe('+15551234567');
      expect(params.get('from')).toBe('MyApp');
      expect(params.get('text')).toBe('Hello');

      expect(event.status).toBe('success');
      expect(event.id).toBe('0A0000000123ABCD');
      expect(event.messageType).toBe('sms');
    });

    it('reports failed for a non-"0" status code, using error-text when present', async () => {
      process.env.VONAGE_API_KEY = 'key123';
      process.env.VONAGE_API_SECRET = 'secret123';
      process.env.VONAGE_FROM_NUMBER = 'MyApp';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          'message-count': '1',
          messages: [{ to: '15551234567', 'message-id': '0000000000000000', status: '4', 'error-text': 'Invalid credentials' }],
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VonageProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid credentials');
    });

    it.each(['1', '2', '3', '5'])(
      'reports failed for non-"0" status code %s even without error-text',
      async (status) => {
        process.env.VONAGE_API_KEY = 'key123';
        process.env.VONAGE_API_SECRET = 'secret123';
        process.env.VONAGE_FROM_NUMBER = 'MyApp';
        const fetchSpy = vi.fn().mockResolvedValue(
          jsonResponse({ 'message-count': '1', messages: [{ to: '15551234567', 'message-id': '0000000000000000', status }] }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const provider = new VonageProvider(makeConfig());
        const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
        expect(event.status).toBe('failed');
        expect(event.error).toContain(status);
      },
    );

    it('reports failed on a non-2xx HTTP error', async () => {
      process.env.VONAGE_API_KEY = 'key123';
      process.env.VONAGE_API_SECRET = 'secret123';
      process.env.VONAGE_FROM_NUMBER = 'MyApp';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}, 500));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VonageProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
      expect(event.status).toBe('failed');
    });

    it('reports failed when the response carries no message-id', async () => {
      process.env.VONAGE_API_KEY = 'key123';
      process.env.VONAGE_API_SECRET = 'secret123';
      process.env.VONAGE_FROM_NUMBER = 'MyApp';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ 'message-count': '0', messages: [] }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VonageProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
      expect(event.status).toBe('failed');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null — native Vonage webhook verification is deliberately not implemented', async () => {
      const provider = new VonageProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBeNull();
    });
  });
});
