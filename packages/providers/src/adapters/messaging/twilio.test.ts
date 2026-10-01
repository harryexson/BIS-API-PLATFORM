import { describe, it, expect, afterEach, vi } from 'vitest';
import { TwilioProvider } from './twilio';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'twilio',
    name: 'Twilio',
    category: 'messaging',
    status: 'online',
    weight: 55,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.0079,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('TwilioProvider', () => {
  const originalSid = process.env.TWILIO_ACCOUNT_SID;
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalFrom = process.env.TWILIO_FROM_NUMBER;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalSid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = originalSid;
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalFrom === undefined) delete process.env.TWILIO_FROM_NUMBER; else process.env.TWILIO_FROM_NUMBER = originalFrom;
  });

  describe('isConfigured()', () => {
    it('requires an account sid, auth token, and from-number', () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
      const provider = new TwilioProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
      expect(provider.isConfigured()).toBe(false);

      process.env.TWILIO_FROM_NUMBER = '+15005550006';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
      const provider = new TwilioProvider(makeConfig());
      provider.setSecrets({ account_sid: 'AC123', auth_token: 'token_123', from_number: '+15005550006' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without credentials (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new TwilioProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^SM/);
    });
  });

  describe('with credentials (real HTTP path)', () => {
    it('sends Basic auth and a form-urlencoded To/From/Body body to the Messages.json endpoint', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
      process.env.TWILIO_FROM_NUMBER = '+15005550006';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ sid: 'SM_abc123', status: 'queued', to: '+15551234567', from: '+15005550006', body: 'Hello', error_code: null }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new TwilioProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
      expect(opts.headers.Authorization).toBe('Basic ' + Buffer.from('AC123:auth_token_123').toString('base64'));
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(opts.body);
      expect(params.get('To')).toBe('+15551234567');
      expect(params.get('From')).toBe('+15005550006');
      expect(params.get('Body')).toBe('Hello');

      expect(event.status).toBe('success');
      expect(event.id).toBe('SM_abc123');
      expect(event.messageType).toBe('sms');
    });

    it('prefixes To/From with "whatsapp:" when metadata.channel is whatsapp', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
      process.env.TWILIO_FROM_NUMBER = '+15005550006';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ sid: 'SM_wa1', status: 'queued' }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new TwilioProvider(makeConfig());
      const event = await provider.processRequest('app1', {
        recipient: '+15551234567', content: 'Hello', metadata: { channel: 'whatsapp' },
      }, 'test');

      const [, opts] = fetchSpy.mock.calls[0];
      const params = new URLSearchParams(opts.body);
      expect(params.get('To')).toBe('whatsapp:+15551234567');
      expect(params.get('From')).toBe('whatsapp:+15005550006');
      expect(event.messageType).toBe('whatsapp');
    });

    it.each(['queued', 'accepted', 'sending', 'sent', 'delivered'])(
      'reports success for the synchronous "accepted for processing" status %s',
      async (status) => {
        process.env.TWILIO_ACCOUNT_SID = 'AC123';
        process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
        process.env.TWILIO_FROM_NUMBER = '+15005550006';
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ sid: 'SM_1', status }));
        vi.stubGlobal('fetch', fetchSpy);

        const provider = new TwilioProvider(makeConfig());
        const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
        expect(event.status).toBe('success');
      },
    );

    it.each(['failed', 'undelivered'])(
      'reports failed for a definite rejection status %s, using error_message',
      async (status) => {
        process.env.TWILIO_ACCOUNT_SID = 'AC123';
        process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
        process.env.TWILIO_FROM_NUMBER = '+15005550006';
        const fetchSpy = vi.fn().mockResolvedValue(
          jsonResponse({ sid: 'SM_1', status, error_code: 30006, error_message: 'Landline or unreachable carrier' }),
        );
        vi.stubGlobal('fetch', fetchSpy);

        const provider = new TwilioProvider(makeConfig());
        const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
        expect(event.status).toBe('failed');
        expect(event.error).toBe('Landline or unreachable carrier');
      },
    );

    it('reports failed on a non-2xx error envelope', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth_token_123';
      process.env.TWILIO_FROM_NUMBER = '+15005550006';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ code: 21211, message: 'The \'To\' number is not a valid phone number.', status: 400 }, 400),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new TwilioProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: 'not-a-number', content: 'Hello' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toContain('not a valid phone number');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null — native Twilio webhook verification is deliberately not implemented', async () => {
      const provider = new TwilioProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', {});
      expect(result).toBeNull();
    });
  });
});
