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

  it('the gateway durably enqueues a correctly signed inbound webhook via the DB fallback (FIXED)', async () => {
    // No REDIS_URL is configured here, so this exercises the fallback path
    // added to enqueueInboundMessage/enqueuePaymentWebhook/enqueueProviderWebhook
    // in services/api-gateway/src/app.ts: a durable `webhook_jobs` row instead
    // of the old silent no-op. Bridging that row into `pipeline`'s live queue
    // (via webhook_job_poller) is exercised end-to-end in the keyword-handling
    // tests below — this test only asserts the gateway's side of the fix.
    const inboundJobsBefore = dbState.webhookJobs.filter((j) => j.jobType === 'inbound_message').length;

    const delivery = await deliverWebhook(runtime, 'signalhouse', buildInboundSms({ text: 'STOP' }));
    expect(delivery.status).toBe(200);
    expect(delivery.json.received).toBe(true);

    // The gateway also fires enqueuePaymentWebhook/enqueueProviderWebhook for
    // every webhook regardless of provider category, so filter to the job
    // type this test cares about rather than assuming array order.
    await waitFor(
      async () => dbState.webhookJobs.filter((j) => j.jobType === 'inbound_message').length > inboundJobsBefore,
      { label: 'inbound_message webhook_jobs row created' },
    );
    const created = dbState.webhookJobs.filter((j) => j.jobType === 'inbound_message').at(-1)!;
    expect(created.status).toBe('pending');

    console.warn('[FIXED] gateway now durably enqueues the inbound webhook (webhook_jobs row) instead of silently dropping it');
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
  // The gateway's inbound webhook route only ever enqueued inbound_message jobs
  // via Redis (services/api-gateway/src/app.ts's enqueueInboundMessage) with no
  // fallback — so with no REDIS_URL configured (the common/default case), every
  // inbound webhook was silently dropped and packages/routing's handleKeyword
  // (which fully implements STOP/HELP/YES/NO/PRAY) never ran. Now the gateway
  // falls back to a durable `webhook_jobs` DB row when Redis is unavailable, and
  // webhook_job_poller bridges it into the worker's queue — see
  // packages/database/src/schema/webhook-jobs.ts and
  // packages/workers/src/jobs/webhookJobPoller.ts.
  async function establishConversationAndDeliver(phone: string, text: string) {
    // Establish an active conversation on the same provider the inbound webhook
    // claims to come from — ConversationResolver requires both to route the
    // inbound message to an owning app.
    await sendMessage(runtime, { recipient: phone, content: 'hi', providerOverride: 'signalhouse' });

    const token = mark();
    const delivery = await deliverWebhook(runtime, 'signalhouse', buildInboundSms({ from: phone, text }));
    expect(delivery.status).toBe(200);
    expect(delivery.json.received).toBe(true);

    // Bridge the DB-fallback-queued job into the worker and let it run.
    await pipeline.queue.enqueue('webhook_job_poller', {});
    await drain(pipeline, ['webhook_job_poller', 'inbound_message', 'keyword_response_delivery']);

    return token;
  }

  const HANDLED_KEYWORDS = [
    { keyword: 'YES', action: 'confirmation' },
    { keyword: 'NO', action: 'confirmation' },
    { keyword: 'HELP', action: 'help' },
    { keyword: 'PRAY', action: 'prayer' },
  ];

  it.each(HANDLED_KEYWORDS)(
    'inbound "$keyword" is routed end-to-end and gets a keyword auto-reply (FIXED)',
    async ({ keyword, action }, index) => {
      const phone = `+15551000${index}`;
      const token = await establishConversationAndDeliver(phone, keyword);

      const responses = busEventsAfter(token, 'messaging').filter(
        (e: any) => e.decisionReason === `keyword_response:${action}`,
      );
      expect(responses.length).toBe(1);
      console.warn(`[FIXED] inbound "${keyword}" is routed to handleKeyword() and produces a "${action}" auto-reply`);
    },
  );

  it('inbound STOP opts the number out and closes the conversation (FIXED)', async () => {
    const phone = '+15551000stop';
    const before = await (async () => {
      await sendMessage(runtime, { recipient: phone, content: 'hi', providerOverride: 'signalhouse' });
      return findConversation(APP_SLUG, phone);
    })();
    expect(before?.status).toBe('active');

    const token = mark();
    const delivery = await deliverWebhook(runtime, 'signalhouse', buildInboundSms({ from: phone, text: 'STOP' }));
    expect(delivery.status).toBe(200);

    await pipeline.queue.enqueue('webhook_job_poller', {});
    await drain(pipeline, ['webhook_job_poller', 'inbound_message', 'keyword_response_delivery']);

    const after = findConversation(APP_SLUG, phone);
    expect(after?.status).toBe('closed');
    expect(
      busEventsAfter(token, 'messaging').some((e: any) => e.decisionReason === 'keyword_response:opt_out'),
    ).toBe(true);
    console.warn('[FIXED] inbound STOP now invokes conversationRepository.close() and the number is opted out');
  });

  // App-specific keywords (a church "check-in" feature, a logistics app's driver
  // lookup) are business logic that belongs to the consuming application, not
  // the platform's generic keyword handler — packages/routing's handleKeyword
  // only implements the universal SMS commands (STOP/HELP/YES/NO/PRAY/JOIN).
  // This remains a real, intentional gap: there is no app-level keyword
  // registration API yet, so these fall through to plain inbound routing.
  const APP_SPECIFIC_KEYWORDS = [
    { keyword: 'CHECK IN', compliant: 'respond with the member’s check-in status' },
    { keyword: 'WHERE IS MY DRIVER?', compliant: 'resolve the trip and reply with the driver/location update' },
  ];

  it.each(APP_SPECIFIC_KEYWORDS)(
    'inbound "$keyword" is routed to the app as a plain message — no app-specific handler exists yet (documented gap)',
    async ({ keyword, compliant }, index) => {
      const phone = `+15551001${index}`;
      const token = await establishConversationAndDeliver(phone, keyword);

      // It's no longer silently dropped — it reaches the app as a routed inbound
      // message — but nothing gives it app-specific business meaning.
      const routed = busEventsAfter(token, 'messaging').filter((e: any) =>
        String(e.decisionReason).startsWith('inbound_routed:'),
      );
      expect(routed.length).toBe(1);
      console.warn(
        `[gap] inbound "${keyword}" now reaches the app as a routed message (previously silently dropped), but a compliant platform would also: ${compliant}`,
      );
    },
  );
});