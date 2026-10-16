import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { WhatsAppProvider } from './whatsapp';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'whatsapp',
    name: 'WhatsApp Business Platform',
    category: 'messaging',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.005,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('WhatsAppProvider', () => {
  const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const originalPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const originalAppSecret = process.env.WHATSAPP_APP_SECRET;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
    if (originalPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhoneId;
    if (originalAppSecret === undefined) delete process.env.WHATSAPP_APP_SECRET; else process.env.WHATSAPP_APP_SECRET = originalAppSecret;
  });

  describe('isConfigured()', () => {
    it('requires both an access token and a phone number id', () => {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      const provider = new WhatsAppProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG_token';
      expect(provider.isConfigured()).toBe(false);

      process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
      expect(provider.isConfigured()).toBe(true);
    });

    it('is configurable via setSecrets() from the admin console', () => {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      const provider = new WhatsAppProvider(makeConfig());
      provider.setSecrets({ access_token: 'EAAG_token', phone_number_id: '123456789' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without credentials (simulated fallback)', () => {
    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new WhatsAppProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^wamid\.sim_/);
      expect(event.messageType).toBe('whatsapp');
    });
  });

  describe('with credentials (real HTTP path)', () => {
    it('sends Bearer auth to /{phone_number_id}/messages with a text-type body', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG_token';
      process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          messaging_product: 'whatsapp',
          contacts: [{ input: '+15551234567', wa_id: '15551234567' }],
          messages: [{ id: 'wamid.abc123' }],
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new WhatsAppProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v21.0/123456789/messages');
      expect(opts.headers.Authorization).toBe('Bearer EAAG_token');
      const body = JSON.parse(opts.body);
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('15551234567');
      expect(body.type).toBe('text');
      expect(body.text.body).toBe('Hello');

      expect(event.status).toBe('success');
      expect(event.id).toBe('wamid.abc123');
      expect(event.messageType).toBe('whatsapp');
    });

    it('reports failed on a non-2xx Graph API error envelope, honestly surfacing the real 24-hour-window rejection', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG_token';
      process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          error: {
            message: "(#131047) Re-engagement message. Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
            type: 'OAuthException',
            code: 131047,
            error_subcode: 2494055,
            fbtrace_id: 'AbC123',
          },
        }, 400),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new WhatsAppProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
      expect(event.status).toBe('failed');
      expect(event.error).toContain('24 hours');
    });

    it('reports failed when the response carries no message id', async () => {
      process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG_token';
      process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ messaging_product: 'whatsapp', messages: [] }));
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new WhatsAppProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15551234567', content: 'Hello' }, 'test');
      expect(event.status).toBe('failed');
    });
  });

  describe('verifyProviderWebhookSignature()', () => {
    it('returns null when no app secret is configured', async () => {
      delete process.env.WHATSAPP_APP_SECRET;
      const provider = new WhatsAppProvider(makeConfig());
      const result = await provider.verifyProviderWebhookSignature('{}', { 'x-hub-signature-256': 'sha256=anything' });
      expect(result).toBeNull();
    });

    it('returns true for a valid sha256= HMAC-SHA256 signature', async () => {
      process.env.WHATSAPP_APP_SECRET = 'app-secret';
      const provider = new WhatsAppProvider(makeConfig());
      const rawBody = '{"object":"whatsapp_business_account"}';
      const digest = createHmac('sha256', 'app-secret').update(rawBody, 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature(rawBody, { 'x-hub-signature-256': `sha256=${digest}` });
      expect(result).toBe(true);
    });

    it('returns false for a tampered body', async () => {
      process.env.WHATSAPP_APP_SECRET = 'app-secret';
      const provider = new WhatsAppProvider(makeConfig());
      const digest = createHmac('sha256', 'app-secret').update('{"object":"whatsapp_business_account"}', 'utf8').digest('hex');

      const result = await provider.verifyProviderWebhookSignature('{"object":"tampered"}', { 'x-hub-signature-256': `sha256=${digest}` });
      expect(result).toBe(false);
    });

    it('returns false when the header is missing or malformed', async () => {
      process.env.WHATSAPP_APP_SECRET = 'app-secret';
      const provider = new WhatsAppProvider(makeConfig());
      expect(await provider.verifyProviderWebhookSignature('{}', {})).toBe(false);
      expect(await provider.verifyProviderWebhookSignature('{}', { 'x-hub-signature-256': 'deadbeef' })).toBe(false);
    });
  });
});
