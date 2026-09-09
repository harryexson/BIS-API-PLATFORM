import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SinchProvider } from './sinch';
import { ProviderConfig } from '@company/schemas';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'sinch',
    name: 'Sinch',
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

describe('SinchProvider', () => {
  const originalToken = process.env.SINCH_API_TOKEN;
  const originalPlanId = process.env.SINCH_SERVICE_PLAN_ID;
  const originalRegion = process.env.SINCH_REGION;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.SINCH_API_TOKEN;
    else process.env.SINCH_API_TOKEN = originalToken;
    if (originalPlanId === undefined) delete process.env.SINCH_SERVICE_PLAN_ID;
    else process.env.SINCH_SERVICE_PLAN_ID = originalPlanId;
    if (originalRegion === undefined) delete process.env.SINCH_REGION;
    else process.env.SINCH_REGION = originalRegion;
  });

  describe('without credentials configured (simulated fallback)', () => {
    beforeEach(() => {
      delete process.env.SINCH_API_TOKEN;
      delete process.env.SINCH_SERVICE_PLAN_ID;
    });

    it('never makes a real HTTP call and returns a fabricated-but-labeled simulated response', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550001', content: 'hi' }, 'test');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^sim-/);
    });
  });

  describe('with credentials configured (real HTTP path)', () => {
    beforeEach(() => {
      process.env.SINCH_API_TOKEN = 'test-token-789';
      process.env.SINCH_SERVICE_PLAN_ID = 'plan-123';
    });

    it('sends the documented batch request shape to the regional endpoint', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'batch-real-1',
            to: ['+15005550001'],
            from: 'Sinch',
            body: 'Hello',
            canceled: false,
            created_at: '2026-09-09T00:00:00Z',
            modified_at: '2026-09-09T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550001', content: 'Hello' }, 'test');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://us.sms.api.sinch.com/xms/v1/plan-123/batches');
      expect(opts.headers.Authorization).toBe('Bearer test-token-789');
      const body = JSON.parse(opts.body);
      expect(body.to).toEqual(['+15005550001']);
      expect(body.body).toBe('Hello');

      expect(event.status).toBe('success');
      expect(event.id).toBe('batch-real-1');
    });

    it('uses the eu region endpoint when SINCH_REGION=eu', async () => {
      process.env.SINCH_REGION = 'eu';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'batch-real-2',
            to: ['+15005550001'],
            from: 'Sinch',
            canceled: false,
            created_at: '2026-09-09T00:00:00Z',
            modified_at: '2026-09-09T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig());
      await provider.processRequest('app1', { recipient: '+15005550001', content: 'hi' }, 'test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://eu.sms.api.sinch.com/xms/v1/plan-123/batches');
    });

    it('reports failure (not fabricated success) when the batch is canceled', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'batch-canceled-1',
            to: ['+15005550001'],
            from: 'Sinch',
            canceled: true,
            created_at: '2026-09-09T00:00:00Z',
            modified_at: '2026-09-09T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550001', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/canceled/);
    });

    it('reports failure on a non-2xx HTTP response and surfaces the error text', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'MissingAPIToken', text: 'No API token provided' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550001', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toBe('No API token provided');
    });

    it('does not fabricate a batch id when the response is malformed', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '+15005550001', content: 'hi' }, 'test');

      expect(event.status).toBe('failed');
      expect(event.error).toMatch(/did not include a batch id/);
    });

    it('reports offline/maintenance status without making an HTTP call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SinchProvider(makeConfig({ status: 'offline' }));
      await expect(
        provider.processRequest('app1', { recipient: '+15005550001', content: 'hi' }, 'test'),
      ).rejects.toThrow(/OFFLINE/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
