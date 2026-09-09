import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VibesProvider } from './vibes';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'vibes',
    name: 'Vibes',
    category: 'messaging',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.007,
    environment: 'live',
    ...overrides,
  };
}

describe('VibesProvider', () => {
  const originalUsername = process.env.VIBES_USERNAME;
  const originalPassword = process.env.VIBES_PASSWORD;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUsername === undefined) delete process.env.VIBES_USERNAME;
    else process.env.VIBES_USERNAME = originalUsername;
    if (originalPassword === undefined) delete process.env.VIBES_PASSWORD;
    else process.env.VIBES_PASSWORD = originalPassword;
  });

  describe('without credentials configured (simulated fallback)', () => {
    beforeEach(() => {
      delete process.env.VIBES_USERNAME;
      delete process.env.VIBES_PASSWORD;
    });

    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VibesProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^vibes-sim-/);
      expect((event.response as any).raw).toMatch(/simulated/i);
    });
  });

  describe('with credentials configured (real HTTP path)', () => {
    beforeEach(() => {
      process.env.VIBES_USERNAME = 'test@example.com';
      process.env.VIBES_PASSWORD = 'test-password';
    });

    it('sends Basic-auth XML request to the documented base URL', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('<mtMessageResponse messageId="vibes-real-1"><status>ACCEPTED</status></mtMessageResponse>', {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VibesProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'Hello' }, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://messageapi.vibesapps.com/MessageApi/mt/messages');
      expect(opts.headers['Content-Type']).toBe('text/xml');
      const expectedAuth = 'Basic ' + Buffer.from('test@example.com:test-password').toString('base64');
      expect(opts.headers.Authorization).toBe(expectedAuth);
      expect(typeof opts.body).toBe('string');
      expect(opts.body).toContain('<mtMessage submitterMessageId=');
      expect(opts.body).toContain('<destination address="+15005550006"/>');
      expect(opts.body).toContain('<text>Hello</text>');

      expect(event.status).toBe('success');
      expect(event.id).toBe('vibes-real-1');
    });

    it('parses a message_id element as a fallback response shape', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('<response><message_id>vibes-real-2</message_id></response>', {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VibesProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(event.status).toBe('success');
      expect(event.id).toBe('vibes-real-2');
    });

    it('reports failure on a non-2xx HTTP response', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('<error>Invalid credentials</error>', {
          status: 401,
          headers: { 'content-type': 'text/xml' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VibesProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/HTTP 401/);
    });

    it('does not fabricate a message id when the response is unparseable', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response('<somethingUnexpected/>', {
          status: 200,
          headers: { 'content-type': 'text/xml' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VibesProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/did not include a recognizable message id/);
    });

    it('reports offline/maintenance status without making an HTTP call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new VibesProvider(makeConfig({ status: 'offline' }));
      await expect(
        provider.processRequest('app1', { recipient: '+15005550006', content: 'hi' }, 'test'),
      ).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
