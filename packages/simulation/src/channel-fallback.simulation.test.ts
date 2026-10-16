import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, APP_SLUG, API_KEY, TENANT_ID } from './db';

// Persistent store replaced by the in-memory double (./db); the gateway,
// routing engine, providers and worker jobs are the REAL code.
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, sendMessage, stopWorker, type SimRuntime, type WorkerHandle } from './harness';

/**
 * Phase 10 — gap register A6 / A8 / A9: "never silently SMS -> Email; the
 * response/event must show requested_channel / selected_channel /
 * fallback_reason, observable and auditable."
 *
 * Every scenario runs through the real gateway HTTP route
 * (POST /v1/api/gateway/messaging) with a real tenant-authenticated API key.
 *
 *  1. explicit channel:'sms' + every SMS provider down + no channel switch
 *     opted into → a clear, specific failure; the email provider is never
 *     handed the message;
 *  2. channelPolicy.allowChannelSwitch:true → a genuine SMS → email
 *     fallback, with requestedChannel/selectedChannel/fallbackReason in the
 *     API response AND the emitted event; requiresConsent enforced;
 *  3. a fallback is NOT permanent: once SMS is back, the next message goes
 *     out on SMS again (conversation continuity no longer pins the fallback
 *     channel);
 *  4. the legacy content inference (>300 chars / 'wa:' → whatsapp) still
 *     applies when no channel is given, and an explicit channel always wins.
 */

const AUTH = { authorization: `Bearer ${API_KEY}`, 'x-tenant-id': TENANT_ID };

// Every provider declaring the 'sms' capability (see packages/providers/src/registry.ts).
const SMS_CAPABLE = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'africastalking', 'sinch', 'vibes', 'twilio', 'vonage'];
const WHATSAPP_CAPABLE = ['infobip', 'signalhouse', 'twilio', 'whatsapp'];

let runtime: SimRuntime;
let worker: WorkerHandle;
const restores: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
  worker = await runtime.makeWorker({});
}, 30_000);

afterAll(async () => {
  await stopWorker(worker);
  await runtime.close();
}, 15_000);

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const id of [...SMS_CAPABLE, 'whatsapp', 'email']) runtime.registry.updateManagement(id, { status: 'online' });
});

function offline(ids: string[]) {
  for (const id of ids) runtime.registry.updateManagement(id, { status: 'offline' });
}

/** Wrap a provider's processRequest to record every payload it is handed (and still run it). */
function spyProvider(providerId: string): Array<Record<string, any>> {
  const calls: Array<Record<string, any>> = [];
  const provider = runtime.registry.getProvider(providerId) as unknown as {
    processRequest: (appId: string, payload: any, reason: string) => Promise<any>;
  };
  const original = provider.processRequest.bind(provider);
  provider.processRequest = async (appId, payload, reason) => {
    calls.push(payload);
    return original(appId, payload, reason);
  };
  restores.push(() => {
    provider.processRequest = original;
  });
  return calls;
}

function failProvider(providerId: string, message: string) {
  const provider = runtime.registry.getProvider(providerId) as unknown as {
    processRequest: (...a: any[]) => Promise<any>;
  };
  const original = provider.processRequest.bind(provider);
  provider.processRequest = async () => {
    throw new Error(message);
  };
  restores.push(() => {
    provider.processRequest = original;
  });
}

async function recordConsent(recipient: string, channel: string, status: 'opted_in' | 'opted_out') {
  const res = await runtime.post('/v1/api/consent', { recipient, channel, status }, { 'content-type': 'application/json', ...AUTH });
  expect(res.status).toBe(200);
}

function busEvent(id: string) {
  return runtime.bus.getHistory().find((e: any) => e.id === id) as any;
}

// ---------------------------------------------------------------------------
// 1. explicit SMS, SMS down, no channel switch → specific failure
// ---------------------------------------------------------------------------

describe('1. explicit channel sms, SMS provider down, allowChannelSwitch not set → clear failure, never email', () => {
  it('fails with a specific channel_unavailable reason; the email provider is never called', async () => {
    offline(SMS_CAPABLE);
    const emailCalls = spyProvider('email');
    const whatsappCalls = spyProvider('whatsapp');

    for (const channelPolicy of [undefined, { allowChannelSwitch: false }]) {
      const res = await sendMessage(
        runtime,
        { recipient: '+15557770001', content: 'Your code is 4821', channel: 'sms', ...(channelPolicy ? { channelPolicy } : {}) },
        AUTH,
      );
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: 'Message routing failed',
        code: 'channel_unavailable',
        requestedChannel: 'sms',
        requestedChannelSource: 'explicit',
        selectedChannel: null,
        fallbackReason: null,
      });
      expect(res.body.detail).toBe(
        "Message not sent: requested channel 'sms' is unavailable — no online, production-eligible sms-capable messaging provider is available. " +
          'Channel switching is not permitted for this message (channelPolicy.allowChannelSwitch is not true), so it was NOT sent on any other channel.',
      );
      // The emitted (tenant-visible) failure event carries the same decision.
      expect(busEvent(res.body.id)).toMatchObject({ status: 'failed', requestedChannel: 'sms', selectedChannel: null, fallbackReason: null });
    }
    expect(emailCalls).toHaveLength(0);
    expect(whatsappCalls).toHaveLength(0);
  });

  it('a requested provider that is down, with every other SMS provider failing, names each failure — still no other channel', async () => {
    offline(['signalhouse']);
    for (const id of SMS_CAPABLE.filter((p) => p !== 'signalhouse')) failProvider(id, `${id} 503 upstream`);
    const emailCalls = spyProvider('email');

    const res = await sendMessage(
      runtime,
      { recipient: '+15557770009', content: 'hello', channel: 'sms', providerOverride: 'signalhouse' },
      AUTH,
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('channel_unavailable');
    const detail = String(res.body.detail);
    expect(detail).toContain("requested provider 'signalhouse' is offline/unavailable or not production-eligible");
    expect(detail).toContain('Messaging dispatch failed on every sms provider tried');
    expect(detail).toMatch(/503 upstream/);
    expect(detail).toContain('NOT sent on any other channel');
    expect(emailCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. opted-in channel switch → genuine, observable fallback
// ---------------------------------------------------------------------------

describe('2. allowChannelSwitch:true → a genuine SMS → email fallback, fully observable', () => {
  it('response AND event carry requestedChannel sms / selectedChannel email / a specific fallbackReason', async () => {
    const phone = '+15557770002';
    const email = 'fallback-2@reachchurch.example';
    await recordConsent(email, 'email', 'opted_in');
    offline(SMS_CAPABLE);
    const emailCalls = spyProvider('email');

    const res = await sendMessage(
      runtime,
      {
        recipient: phone,
        content: 'Service moved to 10am Sunday.',
        channel: 'sms',
        channelPolicy: { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email } },
      },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.providerId).toBe('email');
    expect(res.body.requestedChannel).toBe('sms');
    expect(res.body.requestedChannelSource).toBe('explicit');
    expect(res.body.selectedChannel).toBe('email');
    // Specific — names the requested channel, why it was unavailable, the
    // channel and address actually used, and the caller's opt-in.
    expect(res.body.fallbackReason).toBe(
      "Requested channel 'sms' unavailable: no online, production-eligible sms-capable messaging provider is available. " +
        `Sent on fallback channel 'email' to ${email} because the caller opted in to channel switching for this message (channelPolicy.allowChannelSwitch=true).`,
    );
    // The email adapter was handed the EMAIL address and channel 'email' —
    // never the phone number.
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0]).toMatchObject({ recipient: email, channel: 'email' });

    // The emitted event (SSE / tenant webhooks) is the same object.
    expect(busEvent(res.body.id)).toMatchObject({
      tenantId: TENANT_ID,
      requestedChannel: 'sms',
      selectedChannel: 'email',
      fallbackReason: res.body.fallbackReason,
    });
  });

  it('requiresConsent: without an opt-in on the fallback channel, the switch is refused (and says why)', async () => {
    offline(SMS_CAPABLE);
    const emailCalls = spyProvider('email');
    const res = await sendMessage(
      runtime,
      {
        recipient: '+15557770003',
        content: 'x',
        channel: 'sms',
        channelPolicy: { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email: 'no-consent@reachchurch.example' } },
      },
      AUTH,
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'channel_unavailable', requestedChannel: 'sms', selectedChannel: null, fallbackReason: null });
    expect(String(res.body.detail)).toContain(
      "'email' skipped: recipient no-consent@reachchurch.example has no recorded opt-in for email (channel switching requires the recipient's consent on the fallback channel)",
    );
    expect(emailCalls).toHaveLength(0);
  });

  it('an opt-OUT on the fallback channel, or no address for it, also rules it out', async () => {
    const optedOut = 'opted-out@reachchurch.example';
    await recordConsent(optedOut, 'email', 'opted_out');
    offline(SMS_CAPABLE);
    const emailCalls = spyProvider('email');

    const a = await sendMessage(
      runtime,
      { recipient: '+15557770004', content: 'x', channel: 'sms', channelPolicy: { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email: optedOut } } },
      AUTH,
    );
    expect(a.status).toBe(503);
    expect(String(a.body.detail)).toContain(`'email' skipped: recipient ${optedOut} has opted out of email`);

    // No email address supplied for a phone recipient: a phone number is never "emailed".
    const b = await sendMessage(
      runtime,
      { recipient: '+15557770004', content: 'x', channel: 'sms', channelPolicy: { allowChannelSwitch: true, fallbackChannels: ['email'] } },
      AUTH,
    );
    expect(b.status).toBe(503);
    expect(String(b.body.detail)).toContain("'email' skipped: no email address for this recipient (channelPolicy.fallbackRecipients.email not provided)");
    expect(emailCalls).toHaveLength(0);
  });

  it('when SMS IS available, an opted-in policy changes nothing: selectedChannel sms, fallbackReason null', async () => {
    const res = await sendMessage(
      runtime,
      { recipient: '+15557770005', content: 'x', channel: 'sms', channelPolicy: { allowChannelSwitch: true, fallbackRecipients: { email: 'unused@reachchurch.example' } } },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(SMS_CAPABLE).toContain(res.body.providerId);
    expect(res.body).toMatchObject({ requestedChannel: 'sms', selectedChannel: 'sms', fallbackReason: null });
  });

  it('a malformed channel or channelPolicy is a 400, never silently ignored', async () => {
    const bad = [
      { recipient: '+15557770006', content: 'x', channel: 'fax' },
      { recipient: '+15557770006', content: 'x', channel: 'email' }, // phone number for an explicit email
      { recipient: '+15557770006', content: 'x', channelPolicy: { allowChannelSwitch: 'yes' } },
      { recipient: '+15557770006', content: 'x', channelPolicy: { fallbackChannels: ['pigeon'] } },
      { recipient: '+15557770006', content: 'x', channelPolicy: { fallbackRecipients: { email: '+15557770006' } } },
      { recipient: '+15557770006', content: 'x', channelPolicy: { requiresConsent: false } }, // not request-settable
    ];
    for (const body of bad) {
      const res = await sendMessage(runtime, body as any, AUTH);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. a fallback is not permanent
// ---------------------------------------------------------------------------

describe('3. a channel fallback is never sticky: the next message re-evaluates the requested channel', () => {
  it('after SMS → WhatsApp (same phone number), the next message goes out on SMS once SMS is back', async () => {
    const phone = '+15557770007';
    await recordConsent(phone, 'whatsapp', 'opted_in');
    const policy = { allowChannelSwitch: true, fallbackChannels: ['whatsapp'] };

    // Every SMS-capable provider down → only the WhatsApp Business provider is left.
    offline(SMS_CAPABLE);
    const first = await sendMessage(runtime, { recipient: phone, content: 'first', channel: 'sms', channelPolicy: policy }, AUTH);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ providerId: 'whatsapp', requestedChannel: 'sms', selectedChannel: 'whatsapp' });
    expect(String(first.body.fallbackReason)).toContain("Sent on fallback channel 'whatsapp' to " + phone);
    // The fallback was recorded honestly as a WhatsApp thread with this customer.
    const threads = dbState.conversations.filter((c) => c.appId === APP_SLUG && c.phoneNumber === phone);
    expect(threads.some((c) => c.channel === 'whatsapp' && c.providerId === 'whatsapp')).toBe(true);

    // SMS recovers. The WhatsApp provider is STILL online — before Phase 10,
    // conversation continuity reused it for every later message forever.
    for (const id of SMS_CAPABLE) runtime.registry.updateManagement(id, { status: 'online' });

    const second = await sendMessage(runtime, { recipient: phone, content: 'second', channel: 'sms', channelPolicy: policy }, AUTH);
    expect(second.status).toBe(200);
    expect(SMS_CAPABLE).toContain(second.body.providerId);
    expect(second.body).toMatchObject({ requestedChannel: 'sms', selectedChannel: 'sms', fallbackReason: null });
    expect(String(second.body.decisionReason)).not.toContain('Reusing whatsapp');

    // A legacy caller (no channel field) for the same customer is not pinned either.
    const third = await sendMessage(runtime, { recipient: phone, content: 'third' }, AUTH);
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ requestedChannel: 'sms', requestedChannelSource: 'inferred', selectedChannel: 'sms', fallbackReason: null });
    expect(SMS_CAPABLE).toContain(third.body.providerId);
    // ...and SMS continuity itself still works: the SMS thread's provider is reused.
    expect(third.body.providerId).toBe(second.body.providerId);
    expect(String(third.body.decisionReason)).toContain('Conversation continuity: Reusing sms provider');
  });

  it('after SMS → email, the next message goes out on SMS once SMS is back', async () => {
    const phone = '+15557770008';
    const email = 'fallback-3@reachchurch.example';
    await recordConsent(email, 'email', 'opted_in');
    const policy = { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email } };

    offline(SMS_CAPABLE);
    const first = await sendMessage(runtime, { recipient: phone, content: 'a', channel: 'sms', channelPolicy: policy }, AUTH);
    expect(first.body).toMatchObject({ status: 'success', providerId: 'email', selectedChannel: 'email' });

    for (const id of SMS_CAPABLE) runtime.registry.updateManagement(id, { status: 'online' });
    const second = await sendMessage(runtime, { recipient: phone, content: 'b', channel: 'sms', channelPolicy: policy }, AUTH);
    expect(second.status).toBe(200);
    expect(SMS_CAPABLE).toContain(second.body.providerId);
    expect(second.body).toMatchObject({ selectedChannel: 'sms', fallbackReason: null });
  });
});

// ---------------------------------------------------------------------------
// 4. legacy inference only as the default; explicit always wins
// ---------------------------------------------------------------------------

describe('4. content inference is only the no-channel default; an explicit channel always wins', () => {
  it("no channel: 'wa:' and >300-char bodies still infer whatsapp, a phone number sms, an email address email", async () => {
    const wa = await sendMessage(runtime, { recipient: '+15557771001', content: 'wa: hello from the church' }, AUTH);
    expect(wa.status).toBe(200);
    expect(wa.body).toMatchObject({ requestedChannel: 'whatsapp', requestedChannelSource: 'inferred', selectedChannel: 'whatsapp', fallbackReason: null });
    expect(WHATSAPP_CAPABLE).toContain(wa.body.providerId);
    expect(String(wa.body.decisionReason)).toContain("No channel requested; defaulted to 'whatsapp' by legacy content inference.");

    const long = await sendMessage(runtime, { recipient: '+15557771002', content: 'A'.repeat(301) }, AUTH);
    expect(long.body).toMatchObject({ requestedChannel: 'whatsapp', requestedChannelSource: 'inferred', selectedChannel: 'whatsapp' });
    expect(WHATSAPP_CAPABLE).toContain(long.body.providerId);

    const sms = await sendMessage(runtime, { recipient: '+15557771003', content: 'short' }, AUTH);
    expect(sms.body).toMatchObject({ requestedChannel: 'sms', requestedChannelSource: 'inferred', selectedChannel: 'sms' });
    expect(SMS_CAPABLE).toContain(sms.body.providerId);

    const mail = await sendMessage(runtime, { recipient: 'member@reachchurch.example', content: 'hi' }, AUTH);
    expect(mail.body).toMatchObject({ requestedChannel: 'email', requestedChannelSource: 'inferred', selectedChannel: 'email' });
  });

  it("explicit channel 'sms' wins over a 'wa:' body and over a >300-char body", async () => {
    const whatsappOnly = spyProvider('whatsapp');
    for (const content of ['wa: this is still an SMS', 'B'.repeat(301)]) {
      const res = await sendMessage(runtime, { recipient: '+15557771004', content, channel: 'sms' }, AUTH);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ requestedChannel: 'sms', requestedChannelSource: 'explicit', selectedChannel: 'sms', fallbackReason: null });
      expect(SMS_CAPABLE).toContain(res.body.providerId);
      // The adapter is told the channel (Twilio picks SMS vs WhatsApp from it).
      expect(res.body.payload.channel).toBe('sms');
      expect(String(res.body.decisionReason)).toContain("Channel 'sms' explicitly requested by the caller.");
    }
    expect(whatsappOnly).toHaveLength(0);
  });

  it("explicit channel 'whatsapp' wins over a short body that would have inferred sms", async () => {
    const res = await sendMessage(runtime, { recipient: '+15557771005', content: 'short', channel: 'whatsapp' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requestedChannel: 'whatsapp', requestedChannelSource: 'explicit', selectedChannel: 'whatsapp' });
    expect(WHATSAPP_CAPABLE).toContain(res.body.providerId);
  });

  it('an explicit channel is not overridden by a providerOverride that cannot send on it', async () => {
    // futuresms is SMS-only: forcing it for an explicit WhatsApp message is
    // ignored (and said so), never a silent switch to SMS.
    const res = await sendMessage(runtime, { recipient: '+15557771006', content: 'x', channel: 'whatsapp', providerOverride: 'futuresms' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.selectedChannel).toBe('whatsapp');
    expect(WHATSAPP_CAPABLE).toContain(res.body.providerId);
    expect(String(res.body.decisionReason)).toContain("Override 'futuresms' does not support the 'whatsapp' channel");

    // With NO explicit channel, a forced SMS-only provider keeps a long body
    // on SMS (the inference yields to the caller's explicit provider choice).
    const legacy = await sendMessage(runtime, { recipient: '+15557771007', content: 'C'.repeat(301), providerOverride: 'futuresms' }, AUTH);
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ providerId: 'futuresms', requestedChannel: 'sms', requestedChannelSource: 'inferred', selectedChannel: 'sms' });
  });
});
