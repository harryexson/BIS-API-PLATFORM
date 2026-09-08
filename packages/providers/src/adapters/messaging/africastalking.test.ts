import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AfricasTalkingProvider } from './africastalking';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'africastalking',
    name: "Africa's Talking",
    category: 'messaging',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.006,
    environment: 'live',
    ...overrides,
  };
}

describe('AfricasTalkingProvider', () => {
  const originalApiKey = process.env.AFRICASTALKING_API_KEY;
  const originalUsername = process.env.AFRICASTALKING_USERNAME;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.AFRICASTALKING_API_KEY;
    else process.env.AFRICASTALKING_API_KEY = originalApiKey;
    if (originalUsername === undefined) delete process.env.AFRICASTALKING_USERNAME;
    else process.env.AFRICASTALKING_USERNAME = originalUsername;
  });

  describe('without credentials configured (simulated fallback)', () => {
    beforeEach(() => {
      delete process.env.AFRICASTALKING_API_KEY;
      delete process.env.AFRICASTALKING_USERNAME;
    });

    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+254700000001', content: 'hi' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^ATPid_sim_/);
    });
  });

  describe('with credentials configured (real HTTP path)', () => {
    beforeEach(() => {
      process.env.AFRICASTALKING_API_KEY = 'test-key-456';
      process.env.AFRICASTALKING_USERNAME = 'testuser';
    });

    it('sends the documented request shape to the live base URL when environment is "live"', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Message: 'Sent to 1/1 Total Cost: KES 0.8000',
              Recipients: [
                { statusCode: 101, number: '+254700000001', status: 'Success', cost: 'KES 0.8000', messageId: 'ATPid_real1' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig({ environment: 'live' }));
      const event = await provider.processRequest('app1', { recipient: '+254700000001', content: 'Hello Kenya' }, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.africastalking.com/version1/messaging');
      expect(opts.headers.apiKey).toBe('test-key-456');
      const body = JSON.parse(opts.body);
      expect(body.username).toBe('testuser');
      expect(body.to).toBe('+254700000001');
      expect(body.message).toBe('Hello Kenya');

      expect(event.status).toBe('success');
      expect(event.id).toBe('ATPid_real1');
    });

    it('uses the sandbox base URL when environment is "test"', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            SMSMessageData: { Message: 'ok', Recipients: [{ statusCode: 101, number: '+254700000001', status: 'Success', messageId: 'x' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig({ environment: 'test' }));
      await provider.processRequest('app1', { recipient: '+254700000001', content: 'hi' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    });

    it('reports failure (not fabricated success) when a recipient status is not "Success"', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Message: 'Sent to 0/1',
              Recipients: [
                { statusCode: 401, number: '+254700000001', status: 'InsufficientBalance', messageId: 'ATPid_fail1' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+254700000001', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('InsufficientBalance');
    });

    it('reports failure on a non-2xx HTTP response', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+254700000001', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/HTTP 401/);
    });

    it('does not fabricate a message id when the response is malformed', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SMSMessageData: { Message: 'x', Recipients: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+254700000001', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/did not include a recipient result/);
    });

    it('reports offline/maintenance status without making an HTTP call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new AfricasTalkingProvider(makeConfig({ status: 'offline' }));
      await expect(
        provider.processRequest('app1', { recipient: '+254700000001', content: 'hi' }, 'test'),
      ).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
