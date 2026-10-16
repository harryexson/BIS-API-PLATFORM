import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 10 — gap register A6 / A8 / A9, at the routing-engine level (data
 * access stubbed). The same behaviour is exercised end to end through the
 * real gateway in packages/simulation/src/channel-fallback.simulation.test.ts.
 */

const db = vi.hoisted(() => ({
  consent: new Map<string, string>(), // `${recipient}|${channel}` -> status
  consentLookupThrows: false,
  threads: [] as Array<{ providerId: string; channel: string; status: string; businessNumber: string | null }>,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consentRecordRepository: {
      isOptedOut: async (_a: string, _t: string, recipient: string, channel: string) => db.consent.get(`${recipient}|${channel}`) === 'opted_out',
      findByRecipient: async (_a: string, _t: string, recipient: string, channel: string) => {
        if (db.consentLookupThrows) throw new Error('connection refused');
        const status = db.consent.get(`${recipient}|${channel}`);
        return status ? { status } : undefined;
      },
    },
    messagingProfileRepository: { findSendersForOwner: async () => [] },
    senderOptOutRepository: { isOptedOut: async () => false },
    conversationRepository: {
      findActiveForOwner: async () => db.threads,
      upsert: async (phone: string, appId: string, data: Record<string, unknown>) => {
        db.upserts.push({ phone, appId, ...data });
        return { id: 'c1' };
      },
    },
  };
});

import {
  RoutingEngine,
  MessageChannelUnavailableError,
  InvalidMessageChannelRequestError,
  DEFAULT_FALLBACK_POLICY,
  inferChannelFromContent,
  resolveRequestedChannel,
  parseChannelPolicy,
  addressSuitsChannel,
} from './index';
import { ProviderRegistry } from '@company/providers';

const SMS_CAPABLE = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'africastalking', 'sinch', 'vibes', 'twilio', 'vonage'];
const ALL_MSG = [...SMS_CAPABLE, 'whatsapp', 'email'];

const registry = ProviderRegistry.getInstance();
const restores: Array<() => void> = [];

function spy(providerId: string): Array<Record<string, any>> {
  const calls: Array<Record<string, any>> = [];
  const p = registry.getProvider(providerId) as any;
  const original = p.processRequest.bind(p);
  p.processRequest = async (appId: string, payload: any, reason: string) => {
    calls.push(payload);
    return original(appId, payload, reason);
  };
  restores.push(() => {
    p.processRequest = original;
  });
  return calls;
}

beforeEach(() => {
  db.consent.clear();
  db.consentLookupThrows = false;
  db.threads = [];
  db.upserts = [];
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  for (const id of ALL_MSG) registry.updateProviderConfig(id, { status: 'online' });
});

describe('channel inference / explicit request (A6)', () => {
  it('legacy inference is unchanged for callers that send no channel', () => {
    expect(inferChannelFromContent('a@b.co', 'hi')).toBe('email');
    expect(inferChannelFromContent('+15550001111', 'wa: hi')).toBe('whatsapp');
    expect(inferChannelFromContent('+15550001111', 'x'.repeat(301))).toBe('whatsapp');
    expect(inferChannelFromContent('+15550001111', 'x'.repeat(300))).toBe('sms');
    expect(inferChannelFromContent('whatsapp:+15550001111', 'hi')).toBe('whatsapp');
  });

  it('an explicit channel always wins over the content heuristic', () => {
    expect(resolveRequestedChannel({ explicit: 'sms', recipient: '+15550001111', content: 'wa: ' + 'x'.repeat(400) }))
      .toMatchObject({ channel: 'sms', source: 'explicit' });
    expect(resolveRequestedChannel({ explicit: 'WhatsApp', recipient: '+15550001111', content: 'hi' }))
      .toMatchObject({ channel: 'whatsapp', source: 'explicit' });
    expect(resolveRequestedChannel({ explicit: undefined, recipient: '+15550001111', content: 'wa: hi' }))
      .toMatchObject({ channel: 'whatsapp', source: 'inferred' });
  });

  it('an explicit channel that is invalid or does not fit the recipient is rejected, not guessed around', () => {
    expect(() => resolveRequestedChannel({ explicit: 'fax', recipient: '+1555', content: '' })).toThrow(InvalidMessageChannelRequestError);
    expect(() => resolveRequestedChannel({ explicit: 'email', recipient: '+1555', content: '' })).toThrow(/not a valid email address/);
    expect(() => resolveRequestedChannel({ explicit: 'sms', recipient: 'a@b.co', content: '' })).toThrow(/not a valid sms address/);
    expect(addressSuitsChannel('whatsapp:+1555', 'sms')).toBe(false);
  });

  it('channelPolicy is validated strictly; requiresConsent is not request-settable', () => {
    expect(parseChannelPolicy(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseChannelPolicy({ allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email: 'a@b.co' } }).ok).toBe(true);
    expect(parseChannelPolicy({ allowChannelSwitch: 'true' }).ok).toBe(false);
    expect(parseChannelPolicy({ fallbackChannels: ['email', 'email'] }).ok).toBe(false);
    expect(parseChannelPolicy({ requiresConsent: false }).ok).toBe(false);
    expect(DEFAULT_FALLBACK_POLICY).toEqual({ allowAlternateProvider: true, allowChannelSwitch: false, requiresConsent: true });
  });
});

describe('RoutingEngine.routeMessage — allowChannelSwitch enforced (A9), no any-channel last resort (A8)', () => {
  it('explicit sms, every SMS provider offline, no opt-in → MessageChannelUnavailableError; email never called', async () => {
    for (const id of SMS_CAPABLE) registry.updateProviderConfig(id, { status: 'offline' });
    const email = spy('email');
    const whatsapp = spy('whatsapp');
    const err = await new RoutingEngine()
      .routeMessage('reach', { recipient: '+15550001111', content: 'hi', channel: 'sms', tenantId: 't1' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MessageChannelUnavailableError);
    expect(err.requestedChannel).toBe('sms');
    expect(err.requestedChannelSource).toBe('explicit');
    expect(err.reason).toContain('no online, production-eligible sms-capable messaging provider is available');
    expect(err.reason).toContain('NOT sent on any other channel');
    expect(email).toHaveLength(0);
    expect(whatsapp).toHaveLength(0);
  });

  it('the same for a legacy (no channel) caller — previously this silently went out on another channel', async () => {
    for (const id of [...SMS_CAPABLE, 'whatsapp']) registry.updateProviderConfig(id, { status: 'offline' });
    const email = spy('email');
    await expect(new RoutingEngine().routeMessage('reach', { recipient: '+15550001111', content: 'hi', tenantId: 't1' }))
      .rejects.toBeInstanceOf(MessageChannelUnavailableError);
    expect(email).toHaveLength(0);
  });

  it('opted-in switch with consent → event shows requested sms / selected email / specific reason', async () => {
    for (const id of SMS_CAPABLE) registry.updateProviderConfig(id, { status: 'offline' });
    db.consent.set('m@reach.example|email', 'opted_in');
    const email = spy('email');
    const event = await new RoutingEngine().routeMessage('reach', {
      recipient: '+15550001111',
      content: 'hi',
      channel: 'sms',
      tenantId: 't1',
      channelPolicy: { allowChannelSwitch: true, fallbackRecipients: { email: 'm@reach.example' } },
    });
    expect(event.providerId).toBe('email');
    expect(event).toMatchObject({ requestedChannel: 'sms', requestedChannelSource: 'explicit', selectedChannel: 'email' });
    // Default fallback order is [whatsapp, email]; whatsapp was tried first
    // (its only provider is online) but has no opt-in, so it is reported.
    expect(event.fallbackReason).toContain("Requested channel 'sms' unavailable: no online, production-eligible sms-capable messaging provider is available.");
    expect(event.fallbackReason).toContain("Sent on fallback channel 'email' to m@reach.example");
    expect(event.fallbackReason).toContain("'whatsapp' skipped: recipient +15550001111 has no recorded opt-in for whatsapp");
    expect(email[0]).toMatchObject({ recipient: 'm@reach.example', channel: 'email' });
    // Recorded on the channel actually used, for the address actually used.
    expect(db.upserts.at(-1)).toMatchObject({ phone: 'm@reach.example', channel: 'email', providerId: 'email' });
  });

  it('a consent lookup error rules the fallback channel out (fail closed)', async () => {
    for (const id of SMS_CAPABLE) registry.updateProviderConfig(id, { status: 'offline' });
    db.consentLookupThrows = true;
    const err = await new RoutingEngine()
      .routeMessage('reach', {
        recipient: '+15550001111', content: 'hi', channel: 'sms', tenantId: 't1',
        channelPolicy: { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email: 'm@reach.example' } },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MessageChannelUnavailableError);
    expect(err.reason).toContain("'email' skipped: consent lookup for m@reach.example on email failed (connection refused)");
  });

  it('every event carries the decision; fallbackReason is null when the channel is unchanged', async () => {
    const event = await new RoutingEngine().routeMessage('reach', { recipient: '+15550001111', content: 'hi', tenantId: 't1' });
    expect(event).toMatchObject({ requestedChannel: 'sms', requestedChannelSource: 'inferred', selectedChannel: 'sms', fallbackReason: null });
    expect(event.payload.channel).toBe('sms');
  });
});

describe('conversation continuity is channel-scoped — a fallback is never sticky (A8/A9)', () => {
  it('a more recent WhatsApp thread (from an earlier fallback) does not capture an SMS send', async () => {
    // Newest first, exactly as findActiveForOwner orders them: the
    // fallback's WhatsApp thread, then the customer's original SMS thread.
    db.threads = [
      { providerId: 'whatsapp', channel: 'whatsapp', status: 'active', businessNumber: null },
      { providerId: 'futuresms', channel: 'sms', status: 'active', businessNumber: null },
    ];
    const whatsapp = spy('whatsapp');
    const event = await new RoutingEngine().routeMessage('reach', { recipient: '+15550001111', content: 'hi', channel: 'sms', tenantId: 't1' });
    expect(event.providerId).toBe('futuresms');
    expect(event.decisionReason).toContain("Conversation continuity: Reusing sms provider 'Future SMS'");
    expect(event).toMatchObject({ selectedChannel: 'sms', fallbackReason: null });
    expect(whatsapp).toHaveLength(0);
  });

  it('with only a thread on another channel, the send is routed fresh on its own channel', async () => {
    db.threads = [{ providerId: 'email', channel: 'email', status: 'active', businessNumber: null }];
    const event = await new RoutingEngine().routeMessage('reach', { recipient: '+15550001111', content: 'hi', channel: 'sms', tenantId: 't1' });
    expect(SMS_CAPABLE).toContain(event.providerId);
    expect(event.decisionReason).not.toContain('Conversation continuity');
  });
});
