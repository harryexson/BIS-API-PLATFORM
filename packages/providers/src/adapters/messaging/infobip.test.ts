import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InfobipProvider } from './infobip';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'infobip',
    name: 'Infobip',
    category: 'messaging',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.008,
    ...overrides,
  };
}

describe('InfobipProvider', () => {
  const originalApiKey = process.env.INFOBIP_API_KEY;
  const originalBaseUrl = process.env.INFOBIP_BASE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.INFOBIP_API_KEY;
    else process.env.INFOBIP_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.INFOBIP_BASE_URL;
    else process.env.INFOBIP_BASE_URL = originalBaseUrl;
  });

  describe('without credentials configured (simulated fallback)', () => {
    beforeEach(() => {
      delete process.env.INFOBIP_API_KEY;
      delete process.env.INFOBIP_BASE_URL;
    });

    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.response.bulkId).toMatch(/^sim-/);
    });
  });

  describe('with credentials configured (real HTTP path)', () => {
    beforeEach(() => {
      process.env.INFOBIP_API_KEY = 'test-key-123';
      process.env.INFOBIP_BASE_URL = 'xxxxx.api.infobip.com';
    });

    it('sends the documented request shape: POST /sms/3/messages, "App <key>" auth, messages/destinations/content body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            bulkId: 'bulk-1',
            messages: [
              {
                to: '+15005550006',
                status: { groupId: 1, groupName: 'PENDING', id: 26, name: 'PENDING_ACCEPTED', description: 'Message sent to next instance' },
                messageId: 'msg-1',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'Hello world' }, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://xxxxx.api.infobip.com/sms/3/messages');
      expect(opts.method).toBe('POST');
      expect(opts.headers.Authorization).toBe('App test-key-123');
      const body = JSON.parse(opts.body);
      expect(body.messages[0].destinations).toEqual([{ to: '+15005550006' }]);
      expect(body.messages[0].content).toEqual({ text: 'Hello world' });

      expect(event.status).toBe('success');
      expect(event.id).toBe('msg-1');
      expect(event.response.bulkId).toBe('bulk-1');
    });

    it('reports failure (not fabricated success) when Infobip returns REJECTED in a 200 response', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            bulkId: 'bulk-2',
            messages: [
              {
                to: 'not-a-real-number',
                status: { groupId: 5, groupName: 'REJECTED', id: 51, name: 'INVALID_DESTINATION_ADDRESS', description: 'Invalid destination address.' },
                messageId: 'msg-2',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: 'not-a-real-number', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Invalid destination address.');
    });

    it('parses Infobip\'s documented error envelope on a non-2xx response', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            requestError: { serviceException: { messageId: 'BAD_REQUEST', text: 'Bad request' } },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('Bad request');
    });

    it('does not fabricate a delivery/message id when the response is malformed', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ bulkId: 'bulk-3', messages: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/did not include a message result/);
    });

    it('retries on 5xx (via BaseProvider.http_request) and eventually reports failure if every attempt fails', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ requestError: { serviceException: { text: 'Internal error' } } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      // BaseProvider's default retry policy is 3 attempts.
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(event.status).toBe('failed');
    }, 15_000);

    it('reports offline/maintenance status without making an HTTP call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new InfobipProvider(makeConfig({ status: 'offline' }));
      await expect(
        provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test'),
      ).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
