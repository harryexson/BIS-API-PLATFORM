import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoutingEngine } from './index';
import { ProviderRegistry } from '@company/providers';

// No database in this unit suite: the consent / sender / conversation
// lookups are stubbed to "not opted out, no existing thread" (the same
// pattern sender-consent.test.ts uses).
vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consentRecordRepository: { isOptedOut: async () => false, findByRecipient: async () => undefined },
    messagingProfileRepository: { findSendersForOwner: async () => [] },
    senderOptOutRepository: { isOptedOut: async () => false },
    conversationRepository: { findActiveForOwner: async () => [], upsert: async () => ({ id: 'c1' }) },
  };
});

/**
 * Phase 26 — gap register E3 / E2 (messaging side), through the real
 * RoutingEngine. Infobip is registered 'live', matches every country ('*')
 * and declares 'sms' — so it is a candidate for every tenant's SMS — but it
 * has no real Infobip integration: it used to return status 'success' for a
 * message that never left the platform. In production it now refuses
 * (definite, nothing sent) and the router fails over to a provider that
 * really sends — proven by the captured outgoing Twilio request.
 */

const SMS_PROVIDERS = ['signalhouse', 'infobip', 'futuresms', 'twilio', 'vonage', 'africastalking', 'sinch', 'vibes', 'example-msg'];
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('Phase 26 — E3: production SMS routing never reports a fabricated delivery', () => {
  const registry = ProviderRegistry.getInstance();

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.unstubAllGlobals();
    registry.getProvider('twilio')!.setSecrets({});
    for (const id of SMS_PROVIDERS) registry.updateProviderConfig(id, { status: 'online' });
  });

  it("an SMS forced to simulation-only Infobip is NOT 'delivered' by it — the router fails over and Twilio really POSTs the message", async () => {
    // Only Infobip (simulation-only) and Twilio (configured, real HTTP) are online.
    for (const id of SMS_PROVIDERS) if (id !== 'infobip' && id !== 'twilio') registry.updateProviderConfig(id, { status: 'offline' });
    registry.getProvider('twilio')!.setSecrets({ account_sid: 'AC_p26', auth_token: 'tok', from_number: '+15005550006' });
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ sid: 'SM_p26', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    const infobipSpy = vi.spyOn(registry.getProvider('infobip')!, 'processRequest');
    process.env.NODE_ENV = 'production';

    const event = await new RoutingEngine().routeMessage('app_p26', {
      recipient: '+15005550199',
      content: 'Your code is 482913',
      providerOverride: 'infobip',
    });

    expect(infobipSpy).toHaveBeenCalledTimes(1); // it WAS tried first…
    await expect(infobipSpy.mock.results[0].value).rejects.toThrow(/not configured for real processing/); // …and refused
    expect(event.providerId).toBe('twilio');
    expect(event.status).toBe('success');
    expect(event.id).toBe('SM_p26');
    expect(String(event.decisionReason)).toContain('Dynamic Failover');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_p26/Messages.json');
    expect(calls[0].body).toContain('Body=Your+code+is+482913');
  });

  it('with no real provider available, the send FAILS honestly instead of returning a fabricated success', async () => {
    for (const id of SMS_PROVIDERS) if (id !== 'infobip') registry.updateProviderConfig(id, { status: 'offline' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.NODE_ENV = 'production';

    await expect(
      new RoutingEngine().routeMessage('app_p26', { recipient: '+15005550199', content: 'Your code is 482913' }),
    ).rejects.toThrow(/Infobip.*not configured for real processing/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
