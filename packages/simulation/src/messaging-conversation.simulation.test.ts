import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  dbState,
  clearDb,
  seedReachChurch,
  installDatabaseMock,
  APP_SLUG,
  TENANT_ID,
  OTHER_TENANT_ID,
  DONOR_PHONE,
  DONOR_EMAIL,
} from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — gateway, worker jobs, routing, providers — is the REAL code.
vi.mock('@company/database', () => installDatabaseMock());

import {
  createSimulation,
  sendMessage,
  deliverWebhook,
  buildInboundSms,
  signWebhook,
  enqueueProviderWebhook,
  enqueueReceipt,
  drain,
  waitFor,
  counts,
  sleep,
  stopWorker,
  findConversation,
  type SimRuntime,
  type WorkerHandle,
} from './harness';

console.warn(
  `\n[simulation] REACH CHURCH messaging + conversation platform — outbound + inbound keyword flows\n`,
);

const AUTH = {
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': TENANT_ID,
};

const SMS_CAPABLE = ['signalhouse', 'infobip', 'futuresms', 'example-msg'];

let runtime: SimRuntime;
let pipeline: WorkerHandle;

const patches: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
  pipeline = await runtime.makeWorker({});
}, 30_000);

afterAll(async () => {
  await stopWorker(pipeline);
  await runtime.close();
}, 15_000);

afterEach(() => {
  while (patches.length > 0) {
    const restore = patches.pop();
    restore?.();
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function patchProviderProcessRequest(
  providerId: string,
  impl: (appId: string, payload: any, decisionReason: string) => Promise<any>,
) {
  const provider = runtime.registry.getProvider(providerId) as unknown as {
    processRequest: (appId: string, payload: any, decisionReason: string) => Promise<any>;
  };
  const original = provider.processRequest.bind(provider);
  provider.processRequest = impl;
  patches.push(() => {
    provider.processRequest = original;
  });
}

function busEventsAfter(token: number, category?: string, providerId?: string) {
  const history = runtime.bus.getHistory();
  return history
    .filter((e: any) => new Date(e.timestamp).getTime() >= token)
    .filter((e: any) => (category ? e.category === category : true))
    .filter((e: any) => (providerId ? e.providerId === providerId : true));
}

function mark(): number {
  return Date.now() - 1;
}

// ---------------------------------------------------------------------------
// Mapping: messaging flow — Messaging -> Application -> POST /messages ->
// API Gateway -> Tenant Resolution -> Messaging Router -> Provider Selection ->
// SignalHouse / Infobip -> Delivery Event -> Platform Webhook -> Conversation Update
// ---------------------------------------------------------------------------

describe('outbound messaging (POST /messages -> gateway -> router -> provider -> Delivery Event)', () => {
  it('sends an SMS: tenant resolution, provider selection, delivery event emitted, status exposed', async () => {
    const token = mark();
    const res = await sendMessage(runtime, {
      recipient: DONOR_PHONE,
      content: 'Welcome to Reach Church — reply HELP anytime.',
    });
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('messaging');
    expect(res.body.status).toBe('success');
    expect(SMS_CAPABLE).toContain(res.body.providerId);

    // Delivery Event: the gateway emits via EventBus (shared singleton).
    expect(busEventsAfter(token, 'messaging').some((e: any) => e.id === res.body.id)).toBe(true);

    // Client can poll the delivery event status.
    const st = await runtime.get(`/v1/api/gateway/transaction/${res.body.id}`, AUTH);
    expect(st.status).toBe(200);
    const status = await st.json();
    expect(status.status).toBe('success');
    expect(status.category).toBe('messaging');
    expect(status.providerId).toBe(res.body.providerId);

    // Conversation Update: outbound delivery is recorded.
    const conv = findConversation(APP_SLUG, DONOR_PHONE);
    expect(conv).toBeDefined();
    expect(conv!.channel).toBe('sms');
    expect(conv!.status).toBe('active');
    expect(conv!.providerId).toBe(res.body.providerId);
  });

  it('routes an email recipient to the email provider by capability', async () => {
    const res = await sendMessage(runtime, {
      recipient: DONOR_EMAIL,
      content: 'Your e-statement is ready.',
    });
    expect(res.status).toBe(200);
    expect(res.body.providerId).toBe('email');
    expect(res.body.messageType).toBe('email');
    const conv = findConversation(APP_SLUG, DONOR_EMAIL);
    expect(conv?.channel).toBe('email');
    expect(conv?.providerId).toBe('email');
  });

  it('enforces auth, tenant isolation, and required fields (401/403/400)', async () => {
    const badKey = await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'x' }, { authorization: 'Bearer invalid-key' });
    expect(badKey.status).toBe(401);

    const crossTenant = await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'x' }, { 'x-tenant-id': OTHER_TENANT_ID });
    expect(crossTenant.status).toBe(403);

    const missing = await runtime.post('/v1/api/gateway/messaging', { recipient: DONOR_PHONE }, AUTH);
    expect(missing.status).toBe(400);
  });

  it('providerOverride forces SignalHouse / Infobip selection', async () => {
    const sig = await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'forced A', providerOverride: 'signalhouse' });
    expect(sig.status).toBe(200);
    expect(sig.body.providerId).toBe('signalhouse');

    const inf = await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'forced B', providerOverride: 'infobip' });
    expect(inf.status).toBe(200);
    expect(inf.body.providerId).toBe('infobip');
  });
});

describe('Provider Selection edge cases', () => {
  it('fails over to a backup messaging provider when the primary throws (Dynamic Failover)', async () => {
    patchProviderProcessRequest('signalhouse', async () => {
      await sleep(5);
      throw new Error('ETIMEDOUT (simulated SignalHouse outage)');
    });

    const res = await sendMessage(runtime, {
      recipient: '+15550002222',
      content: 'ping',
      providerOverride: 'signalhouse',
    });
    expect(res.status).toBe(200);
    // Deterministic: fallback is the first other online messaging provider (Infobip).
    expect(res.body.providerId).toBe('infobip');
    expect(String(res.body.decisionReason)).toContain('Dynamic Failover');
  });

  it('when all SMS providers are offline, an SMS silently falls back to email (documented gap)', async () => {
    const smsProviders = ['signalhouse', 'infobip', 'futuresms', 'example-msg'];
    try {
      for (const p of smsProviders) runtime.registry.updateManagement(p, { status: 'offline' });

      const res = await sendMessage(runtime, {
        recipient: '+15550003333',
        content: 'Please text me back on this number.',
      });
      expect(res.status).toBe(200);
      // Active messaging providers now = [email]; routeMessage defaults there.
      expect(res.body.providerId).toBe('email');
      expect(String(res.body.decisionReason)).toContain('Defaulted to first available messaging channel');
      console.warn('[gap] SMS channel is not preserved when all SMS providers are offline: an SMS silently goes out via email');
    } finally {
      for (const p of smsProviders) runtime.registry.updateManagement(p, { status: 'online' });
    }
  });

  it('a hard routing failure returns 503 and emits a failed routing event', async () => {
    patchProviderProcessRequest('signalhouse', async () => {
      await sleep(5);
      throw new Error('down');
    });
    patchProviderProcessRequest('infobip', async () => {
      await sleep(5);
      throw new Error('down');
    });

    const token = mark();
    const res = await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'x', providerOverride: 'signalhouse' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Message routing failed');

    const failed = busEventsAfter(token, 'messaging').filter((e: any) => e.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((e: any) => e.decisionReason === 'routing_failure')).toBe(true);
  });
});

describe('Delivery Event -> Platform Webhook (worker durable path)', () => {
  it('a worker-processed message writes a durable row and emits the delivery event', async () => {
    const rowsBefore = dbState.events.slice();
    const token = mark();

    const enq = await enqueueReceipt(pipeline.queue, {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'Gift receipt processed by the worker.',
    });
    await waitFor(async () => (await pipeline.queue.getJob(enq.id))?.status === 'completed', {
      label: 'message_delivery job completed',
    });

    const created = dbState.events.filter((r) => !rowsBefore.includes(r));
    expect(created.some((r) => r.category === 'messaging')).toBe(true);
    expect(created.some((r) => r.providerId === 'email')).toBe(true);
    expect(busEventsAfter(token, 'messaging', 'email').length).toBe(1);
  });

  it('the provider_webhook job verifies, records, flips provider status, and de-dupes replays', async () => {
    const rowsBefore = dbState.events.filter((r) => r.category === 'provider_webhook').length;
    const eventId = `pwh_${Math.random().toString(36).slice(2, 10)}`;

    const body = buildInboundSms({ text: 'PING' });
    const rawBody = JSON.stringify(body);
    const signature = signWebhook(rawBody);
    const token = mark();

    const job1 = await enqueueProviderWebhook(pipeline.queue, {
      providerId: 'futuresms',
      rawBody,
      signature,
      id: eventId,
      status: 'offline',
    });
    await waitFor(async () => (await pipeline.queue.getJob(job1.id))?.status === 'completed', {
      label: 'provider_webhook job completed',
    });

    expect(dbState.events.filter((r) => r.category === 'provider_webhook').length).toBe(rowsBefore + 1);
    expect(busEventsAfter(token).some((e: any) => e.decisionReason === 'provider_webhook_processed')).toBe(true);
    expect(runtime.registry.getProvider('futuresms')?.config.status).toBe('offline');

    // Replay with the same event id is rejected at the idempotency guard.
    const job2 = await enqueueProviderWebhook(pipeline.queue, {
      providerId: 'futuresms',
      rawBody,
      signature,
      id: eventId,
      status: 'online',
    });
    await waitFor(async () => (await pipeline.queue.getJob(job2.id))?.status === 'dead', {
      label: 'provider_webhook replay dead-lettered',
    });
    const job2State = await pipeline.queue.getJob(job2.id);
    expect(job2State?.status).toBe('dead');
    expect(job2State?.lastError).toContain('Replay detected');
    expect(runtime.registry.getProvider('futuresms')?.config.status).toBe('offline');

    runtime.registry.updateManagement('futuresms', { status: 'online' });
    void job1;
  });

  it('the gateway accepts a correctly signed inbound webhook but never enqueues it (documented gap)', async () => {
    const qBefore = await counts(pipeline, 'provider_webhook');
    const token = mark();

    const delivery = await deliverWebhook(runtime, 'signalhouse', buildInboundSms({ text: 'STOP' }));
    expect(delivery.status).toBe(200);
    expect(delivery.json.received).toBe(true);

    await sleep(200);
    const qAfter = await counts(pipeline, 'provider_webhook');
    expect(qAfter.ready).toBe(0);
    expect(qAfter.delayed).toBe(0);
    expect(qAfter.dead).toBe(qBefore.dead);
    expect(busEventsAfter(token, 'messaging').length).toBe(0);

    console.warn('[gap] gateway verifies inbound webhook HMAC but does not enqueue provider_webhook: inbound messages are acked then dropped');
  });
});

describe('Conversation Update (ConversationManager record + continuity)', () => {
  it('records an active conversation and reuses the same provider on the next send', async () => {
    const fresh = '+15552224444';
    const first = await sendMessage(runtime, { recipient: fresh, content: 'First SMS' });
    expect(SMS_CAPABLE).toContain(first.body.providerId);

    const conv1 = findConversation(APP_SLUG, fresh);
    expect(conv1?.providerId).toBe(first.body.providerId);
    expect(conv1?.channel).toBe('sms');
    expect(conv1?.status).toBe('active');

    const second = await sendMessage(runtime, { recipient: fresh, content: 'Second SMS' });
    expect(second.body.providerId).toBe(first.body.providerId);
    expect(String(second.body.decisionReason)).toContain('Conversation continuity');
  });

  it('an explicit providerOverride takes priority over conversation continuity', async () => {
    const fresh = '+15553334444';
    const first = await sendMessage(runtime, { recipient: fresh, content: 'First SMS' });
    expect(SMS_CAPABLE).toContain(first.body.providerId);

    const forced = await sendMessage(runtime, { recipient: fresh, content: 'Forced route', providerOverride: 'infobip' });
    expect(forced.status).toBe(200);
    expect(forced.body.providerId).toBe('infobip');

    // record() re-writes the conversation with the override provider.
    expect(findConversation(APP_SLUG, fresh)?.providerId).toBe('infobip');
  });
});

describe('inbound messages: YES / NO / HELP / STOP / PRAY / CHECK IN / WHERE IS MY DRIVER?', () => {
  const KEYWORDS = [
    { keyword: 'YES', compliant: 'acknowledge/confirm the intent and auto-reply with a confirmation' },
    { keyword: 'NO', compliant: 'acknowledge the cancellation and halt the confirmation flow' },
    { keyword: 'HELP', compliant: 'reply with the help text including the STOP opt-out' },
    { keyword: 'STOP', compliant: 'opt the number out, close the conversation, and stop all further messaging' },
    { keyword: 'PRAY', compliant: 'log a prayer request and reply with a confirmation + guidance' },
    { keyword: 'CHECK IN', compliant: 'respond with the member’s check-in status' },
    { keyword: 'WHERE IS MY DRIVER?', compliant: 'resolve the trip and reply with the driver/location update' },
  ];

  it.each(KEYWORDS)(
    'inbound "$keyword" is verified+acked, but no keyword handler runs — documented gap',
    async ({ keyword, compliant }) => {
      const token = mark();
      const inbound = buildInboundSms({ text: keyword });

      // Provider -> Platform Webhook (real HMAC verification).
      const delivery = await deliverWebhook(runtime, 'signalhouse', inbound);
      expect(delivery.status).toBe(200);
      expect(delivery.json.received).toBe(true);

      // Give any (non-existent) async handling a chance to run.
      await sleep(150);

      expect(busEventsAfter(token, 'messaging').length).toBe(0);
      expect((await counts(pipeline, 'provider_webhook')).ready).toBe(0);

      console.warn(`[gap] inbound "${keyword}" is verified but dropped; a compliant platform would: ${compliant}`);
    },
  );

  it('inbound STOP leaves the conversation active instead of closing it (documented gap)', async () => {
    await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'Keeping you in the loop.' });

    const before = findConversation(APP_SLUG, DONOR_PHONE);
    expect(before?.status).toBe('active');

    const delivery = await deliverWebhook(runtime, 'signalhouse', buildInboundSms({ text: 'STOP' }));
    expect(delivery.status).toBe(200);
    await sleep(150);

    const after = findConversation(APP_SLUG, DONOR_PHONE);
    // A compliant platform closes the conversation (opt-out). The platform never
    // calls ConversationManager.close() → the number stays opted in.
    expect(after?.status).toBe('active');
    expect(after?.providerId).toBe(before?.providerId);
    expect(after?.channel).toBe(before?.channel);
    console.warn('[gap] inbound STOP does not invoke ConversationManager.close(); the number remains opted-in and routable');
  });
});