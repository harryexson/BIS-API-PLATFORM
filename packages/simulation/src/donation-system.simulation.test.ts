import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  dbState,
  clearDb,
  seedReachChurch,
  installDatabaseMock,
  APP_SLUG,
  TENANT_ID,
  OTHER_TENANT_ID,
  DONOR_EMAIL,
} from './db';

// Replace the persistent store with the in-memory double (see ./db). The whole
// banana — gateway, worker jobs, routing — sees these mocks; the only thing
// mocked is the database.
vi.mock('@company/database', () => installDatabaseMock());

import {
  createSimulation,
  createDonation,
  deliverWebhook,
  enqueuePaymentWebhook,
  enqueueEventProcessing,
  enqueueReceipt,
  wireReceiptPipeline,
  buildStripeWebhook,
  drain,
  counts,
  sleep,
  waitFor,
  stopWorker,
  withTimeout,
  DEFAULT_WORKER_CONFIG,
  type SimRuntime,
  type WorkerHandle,
} from './harness';
import { MemoryStore, createKeys, type KVStore, type Keys } from '@company/workers';

console.warn(
  `\n[simulation] REACH CHURCH donation platform — end-to-end simulation + deliberate failure tests\n`,
);

let runtime: SimRuntime;
let pipeline: WorkerHandle;
let unsubscribe: (() => void) | undefined;

const patches: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
  pipeline = await runtime.makeWorker({});
  unsubscribe = wireReceiptPipeline(pipeline, runtime);
}, 30_000);

afterAll(async () => {
  unsubscribe?.();
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

function patchStripeProcessRequest(impl: (appId: string, payload: any, decisionReason: string) => Promise<any>) {
  const stripe = runtime.registry.getProvider('stripe') as unknown as {
    processRequest: (appId: string, payload: any, decisionReason: string) => Promise<any>;
  };
  const original = stripe.processRequest.bind(stripe);
  stripe.processRequest = impl;
  patches.push(() => {
    stripe.processRequest = original;
  });
}

/** Return rows created since `baseline` (count-based, newest actual order irrelevant). */
function newRows<T extends { createdAt: Date }>(all: T[], baseline: T[]) {
  // The in-memory repositories append in creation order, so a suffix in time
  // equates to a suffix in the array.
  const known = new Set(baseline);
  return all.filter((row) => !known.has(row));
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
// 1. Happy-path: the complete donation flow end to end
// ---------------------------------------------------------------------------

describe('complete donation flow (Reach Church -> ... -> Giving Receipt)', () => {
  it('routes payment through Stripe, verifies the webhook, records it, and sends a receipt', async () => {
    // ---- Reach Church -> Create Donation -> API Gateway ----
    const donation = await createDonation(runtime);
    expect(donation.status).toBe(200);
    expect(donation.body.status).toBe('success');
    expect(donation.body.providerId).toBe('stripe');
    expect(donation.body.response.status).toBe('succeeded');
    const txId: string = donation.body.id;

    // ---- Authenticate Application (invalid key rejected) ----
    const rejected = await createDonation(runtime, {}, { authorization: 'Bearer invalid-key' });
    expect(rejected.status).toBe(401);

    // ---- Resolve Tenant (unlinked tenant rejected) ----
    const tenantDenied = await createDonation(
      runtime,
      {},
      { 'x-tenant-id': OTHER_TENANT_ID, authorization: 'Bearer bap_test_reachchurch_0001' },
    );
    expect(tenantDenied.status).toBe(403);

    // ---- Stripe -> Webhook + Webhook Verification (real HMAC endpoint) ----
    const rowsBefore = dbState.events.slice();
    const busToken = mark();
    const raw = buildStripeWebhook(txId);
    const delivery = await deliverWebhook(runtime, 'stripe', raw);
    expect(delivery.status).toBe(200);
    expect(delivery.json.received).toBe(true);

    // ---- Worker: signature re-check + idempotency + Transaction Update ----
    await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      id: txId,
    });

    // ---- Event Processing ----
    await enqueueEventProcessing(pipeline.queue, { ...donation.body });
    await drain(pipeline, ['payment_webhook', 'event_processing', 'message_delivery']);

    // ---- Transaction Update durable row ----
    const webhookRows = newRows(dbState.events, rowsBefore).filter((r) => r.category === 'payment_webhook');
    expect(webhookRows.length).toBe(1);
    expect(String((webhookRows[0].payload as any)?.type)).toBe('charge.succeeded');
    expect(webhookRows[0].status).toBe('success');

    // ---- Event Processing rows ----
    expect(newRows(dbState.events, rowsBefore).some((r) => r.category === 'payment' && r.providerId === 'stripe')).toBe(true);

    // ---- Giving Receipt (wired pipeline) ----
    const messaging = busEventsAfter(busToken, 'messaging', 'email');
    expect(messaging.some((e: any) => (e.payload?.recipient ?? e.response?.recipient) === DONOR_EMAIL)).toBe(true);

    // ---- Client can poll transaction status ----
    const statusRes = await runtime.get(`/v1/api/gateway/transaction/${txId}`, {
      authorization: 'Bearer bap_test_reachchurch_0001',
      'x-tenant-id': TENANT_ID,
    });
    const status = await statusRes.json();
    expect(statusRes.status).toBe(200);
    expect(status.status).toBe('success');
    expect(status.providerTransactionId).toBe(txId);
  });

  it('rejects a webhook whose HMAC signature does not verify', async () => {
    const rawBody = JSON.stringify(buildStripeWebhook('ch_bad_0001'));
    const res = await runtime.postText('/v1/api/webhooks/stripe', rawBody, {
      'x-webhook-signature': 'deadbeef',
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate requests
// ---------------------------------------------------------------------------

describe('deliberate: duplicate requests', () => {
  it('payment submission has no server-side idempotency — two identical POSTs charge twice (documented gap)', async () => {
    const first = await createDonation(runtime, { amount: 25, idempotencyKey: 'donate:storefront:001' });
    const second = await createDonation(runtime, { amount: 25, idempotencyKey: 'donate:storefront:001' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.id).not.toBe(second.body.id);
    // The platform ignores idempotency-key at the gateway layer → the gap we want surfaced.
    console.warn('[gap] POST /v1/api/gateway/payment ignores Idempotency-Key: duplicate requests => duplicate charges');
  });

  it('but the worker de-duplicates a replayed webhook for the same charge', async () => {
    const donation = await createDonation(runtime);
    const txId = donation.body.id;
    const rowsBefore = dbState.events.filter((r) => r.category === 'payment_webhook').length;
    const busToken = mark();

    const first = await deliverWebhook(runtime, 'stripe', buildStripeWebhook(txId));
    expect(first.status).toBe(200);
    const job1 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: first.rawBody,
      signature: first.signature,
      id: txId,
    });
    await drain(pipeline, ['payment_webhook', 'message_delivery']);

    // Deliver the identical webhook a second time.
    const second = await deliverWebhook(runtime, 'stripe', buildStripeWebhook(txId));
    const job2 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: second.rawBody,
      signature: second.signature,
      id: txId,
    });
    await drain(pipeline, ['payment_webhook', 'message_delivery']);

    // Exactly one record and one receipt — no double charge / double receipt.
    expect(dbState.events.filter((r) => r.category === 'payment_webhook').length).toBe(rowsBefore + 1);
    expect(busEventsAfter(busToken, 'messaging', 'email').length).toBe(1);

    // The replay was rejected at the idempotency guard and dead-lettered.
    const finalJob = await pipeline.queue.getJob(job2.id);
    expect(finalJob?.status).toBe('dead');
    expect(finalJob?.lastError).toContain('Replay detected');
    expect(job1.id).not.toBe(job2.id);
  });
});

// ---------------------------------------------------------------------------
// 3. Provider timeout
// ---------------------------------------------------------------------------

describe('deliberate: provider timeout', () => {
  it('caps a slow/failing Stripe request via failover to another payment provider', async () => {
    patchStripeProcessRequest(async () => {
      await sleep(30);
      throw new Error('ETIMEDOUT: read ETIMEDOUT (simulated Stripe gateway timeout)');
    });
    const donation = await createDonation(runtime);
    expect(donation.status).toBe(200);
    expect(donation.body.providerId).not.toBe('stripe');
    expect(String(donation.body.decisionReason)).toContain('Dynamic Failover');
  });

  it('documents the gap when a provider hangs forever: gateway has no per-request timeout', async () => {
    patchStripeProcessRequest(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = runtime.request('POST', '/v1/api/gateway/payment', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bap_test_reachchurch_0001',
        'x-tenant-id': TENANT_ID,
      },
      body: JSON.stringify({ amount: 50, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe' }),
      signal: controller.signal,
    });
    await expect(withTimeout(pending, 1200, 'gateway response to hanging provider')).rejects.toThrow('timed out');
    controller.abort();
    console.warn('[gap] no request-level timeout around provider calls: hangs tie up gateway + DB-free HTTP connections');
  });
});

// ---------------------------------------------------------------------------
// 4. Webhook delivered twice
// ---------------------------------------------------------------------------

describe('deliberate: webhook arriving twice', () => {
  it('only honours the first, and the second is dropped at the worker idempotency guard', async () => {
    const donation = await createDonation(runtime);
    const txId = donation.body.id;
    const rowsBefore = dbState.events.filter((r) => r.category === 'payment_webhook').length;
    const busToken = mark();

    const first = await deliverWebhook(runtime, 'stripe', buildStripeWebhook(txId));
    const job1 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: first.rawBody,
      signature: first.signature,
      id: txId,
    });
    await drain(pipeline, ['payment_webhook', 'message_delivery']);

    const second = await deliverWebhook(runtime, 'stripe', buildStripeWebhook(txId));
    const job2 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: second.rawBody,
      signature: second.signature,
      id: txId,
    });
    await drain(pipeline, ['payment_webhook', 'message_delivery']);

    expect(dbState.events.filter((r) => r.category === 'payment_webhook').length).toBe(rowsBefore + 1);
    expect(busEventsAfter(busToken, 'messaging', 'email').length).toBe(1);
    const job2State = await pipeline.queue.getJob(job2.id);
    expect(job2State?.status).toBe('dead');
    void job1;
  });
});

// ---------------------------------------------------------------------------
// 5. Webhook arriving before the client receives its response
// ---------------------------------------------------------------------------

describe('deliberate: webhook racing ahead of the client response', () => {
  it('durable state (webhook) beats the in-flight POST; ordering is not corrupted', async () => {
    const raceChargeId = 'ch_race_0001';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const originalStripe = runtime.registry.getProvider('stripe') as unknown as {
      processRequest: (appId: string, payload: any, decisionReason: string) => Promise<any>;
    };
    const base = originalStripe.processRequest.bind(originalStripe);
    patchStripeProcessRequest(async (appId, payload, reason) => {
      await gate;
      const event = await base(appId, payload, reason);
      event.id = raceChargeId;
      event.response = { ...event.response, id: raceChargeId };
      return event;
    });

    // Start the donation request — it is parked inside the provider call.
    const pending = runtime.request('POST', '/v1/api/gateway/payment', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bap_test_reachchurch_0001',
        'x-tenant-id': TENANT_ID,
      },
      body: JSON.stringify({ amount: 50, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe' }),
    });
    await sleep(80);

    // While the client waits, Stripe's webhook arrives and is fully processed.
    const rowsToken = dbState.events.length;
    const delivery = await deliverWebhook(runtime, 'stripe', buildStripeWebhook(raceChargeId));
    expect(delivery.status).toBe(200);
    await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      id: raceChargeId,
    });
    await drain(pipeline, ['payment_webhook', 'message_delivery']);

    // PROOF: durable update happened before the client response existed.
    expect(dbState.events.length).toBeGreaterThan(rowsToken);

    // Now let the client response through — it must reference the same charge.
    release();
    const res = await withTimeout(pending, 5000, 'creation response after webhook');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe(raceChargeId);

    // And the client can poll transaction status to its settled state.
    const statusRes = await runtime.get(`/v1/api/gateway/transaction/${raceChargeId}`, {
      authorization: 'Bearer bap_test_reachchurch_0001',
      'x-tenant-id': TENANT_ID,
    });
    expect(statusRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. Ambiguous provider response
// ---------------------------------------------------------------------------

describe('deliberate: ambiguous provider response', () => {
  it('a provider returning a non-terminal status is treated as "success" (documented gap: no pending state)', async () => {
    patchStripeProcessRequest(async (appId, payload, decisionReason) => {
      await sleep(5);
      return {
        id: 'ch_amb_0001',
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: 'stripe',
        status: 'success',
        amount: payload.amount,
        currency: payload.currency,
        latency: 5,
        cost: 1.75,
        decisionReason,
        payload,
        response: { id: 'ch_amb_0001', object: 'charge', status: 'processing', paid: false },
      };
    });
    const donation = await createDonation(runtime);
    expect(donation.status).toBe(200);
    expect(donation.body.status).toBe('success');
    expect(donation.body.response.status).toBe('processing');

    const statusRes = await runtime.get(`/v1/api/gateway/transaction/ch_amb_0001`, {
      authorization: 'Bearer bap_test_reachchurch_0001',
      'x-tenant-id': TENANT_ID,
    });
    const status = await statusRes.json();
    expect(status.status).toBe('success');
    expect(status.providerTransactionId).toBe('ch_amb_0001');
    console.warn(
      '[gap] TransactionEvent.status only supports "success"|"failed": a pending/ambiguous provider state is silently accepted as success',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Database failure during processing
// ---------------------------------------------------------------------------

describe('deliberate: database failure during processing', () => {
  it('DB write failure causes the job to be retried then dead-lettered; receipt does not fire without persistence', async () => {
    const donation = await createDonation(runtime);
    const txId = donation.body.id;
    const rowsBefore = dbState.events.length;
    const busToken = mark();

    dbState.failEventWrites = true;
    try {
      const delivery = await deliverWebhook(runtime, 'stripe', buildStripeWebhook(txId));
      expect(delivery.status).toBe(200);
      const job = await enqueuePaymentWebhook(pipeline.queue, {
        appId: APP_SLUG,
        providerId: 'stripe',
        rawBody: delivery.rawBody,
        signature: delivery.signature,
        id: txId,
      });
      await drain(pipeline, ['payment_webhook', 'message_delivery']);

      // P0: DB failure causes retry → dead-letter (fail-fast, not graceful)
      const jobState = await pipeline.queue.getJob(job.id);
      expect(jobState?.status).toBe('dead');

      // Nothing durable was written.
      expect(dbState.events.length).toBe(rowsBefore);

      // The flow did NOT continue in-memory: DB failure prevented further processing.
      expect(busEventsAfter(busToken, 'payment').some((e: any) => e.id === txId)).toBe(false);
      expect(busEventsAfter(busToken, 'messaging', 'email').length).toBe(0);

      console.warn(
        '[gap] DB outage causes job dead-lettering; no receipt fired — provider webhook replay (or reconciliation) is the recovery path',
      );
    } finally {
      dbState.failEventWrites = false;
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Worker restart
// ---------------------------------------------------------------------------

describe('deliberate: worker restart', () => {
  it('queued work survives a restart; failed jobs are retried and eventually dead-lettered; idempotency persists', async () => {
    const store = new MemoryStore();
    const keys = createKeys('sim-restart');
    const config = {
      ...DEFAULT_WORKER_CONFIG,
      queuePrefix: 'sim-restart',
      retry: { ...DEFAULT_WORKER_CONFIG.retry, maxAttempts: 2, maxDelayMs: 30, maxDeadRetries: 1 },
    };
    const historyToken = mark();
    const goodIdemKey = 'rc:gift:idem';

    // ---- Worker #1 ----
    const worker1 = await runtime.makeWorker({ store, keys, config });
    const goodJob = await enqueueReceipt(worker1.queue, {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'Gift receipt #1',
    });
    const failingJob = await worker1.queue.enqueue('message_delivery', { appId: APP_SLUG });
    await drain(worker1, ['message_delivery']);

    expect(busEventsAfter(historyToken, 'messaging', 'email').length).toBe(1);
    expect((await worker1.queue.getJob(goodJob.id))?.status).toBe('completed');
    expect((await worker1.queue.getJob(failingJob.id))?.status).toBe('dead');
    expect((await counts(worker1, 'message_delivery')).dead).toBe(1);
    await stopWorker(worker1);

    // ---- Worker #2: same store/keys — retry processing resurrects dead job ----
    const worker2 = await runtime.makeWorker({ store, keys, config });
    await worker2.queue.enqueue('retry_processing', {});
    await drain(worker2, ['retry_processing', 'message_delivery']);

    const deadIds = await worker2.queue.deadJobs('message_delivery');
    let resurrected: any = null;
    for (const id of deadIds) {
      const job = await worker2.queue.getJob(id);
      if (job && job.payload && !job.payload.recipient) resurrected = job;
    }
    expect(resurrected).not.toBeNull();
    expect(resurrected.deadRetries).toBe(1);

    // ---- Idempotency persists across restart ----
    const idemGood = await enqueueReceipt(worker2.queue, {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'Gift receipt #2',
    });
    await waitFor(async () => (await worker2.queue.getJob(idemGood.id))?.status === 'completed', {
      timeoutMs: 10_000,
      label: 'idempotent gift',
    });
    expect(busEventsAfter(historyToken, 'messaging', 'email').length).toBe(2);
    await stopWorker(worker2);

    // ---- Worker #3: same idempotency key must NOT reprocess ----
    const worker3 = await runtime.makeWorker({ store, keys, config });
    const again = await enqueueReceipt(worker3.queue, {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'Gift receipt #2',
    });
    await waitFor(async () => (await worker3.queue.getJob(again.id))?.status === 'completed', {
      timeoutMs: 10_000,
      label: 'idempotent replay after restart',
    });
    expect(busEventsAfter(historyToken, 'messaging', 'email').length).toBe(2);
    await stopWorker(worker3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. Refund
// ---------------------------------------------------------------------------

describe('deliberate: refund', () => {
  it('no server refund endpoint exists (client resource only) — the charge can only be refunded in the provider panel', async () => {
    const res = await runtime.request('POST', '/refunds', {
      headers: { 'content-type': 'application/json', authorization: 'Bearer bap_test_reachchurch_0001' },
      body: JSON.stringify({ amount: 50, charge: 'ch_xyz' }),
    });
    expect(res.status).toBe(404);
    console.warn('[gap] POST /refunds has no gateway route; BaseProvider has no refund(); the api-client RefundsResource is unimplemented server-side');
  });

  it('the webhook pipeline handles a charge.refunded event end-to-end and notifies the donor', async () => {
    const donation = await createDonation(runtime);
    const txId = donation.body.id;
    const rowsBefore = dbState.events.filter((r) => (r.payload as any)?.type === 'charge.refunded').length;
    const busToken = mark();

    const delivery = await deliverWebhook(
      runtime,
      'stripe',
      buildStripeWebhook(txId, {
        type: 'charge.refunded',
        data: { object: { status: 'refunded', amount_refunded: 5000 } },
      }),
    );
    expect(delivery.status).toBe(200);
    await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: delivery.rawBody,
      signature: delivery.signature,
      id: txId,
    });
    await enqueueReceipt(pipeline.queue, {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'Reach Church: your donation of $50.00 has been refunded.',
    });
    await drain(pipeline, ['payment_webhook', 'message_delivery']);

    expect(dbState.events.filter((r) => (r.payload as any)?.type === 'charge.refunded').length).toBe(rowsBefore + 1);
    const notices = busEventsAfter(busToken, 'messaging', 'email');
    expect(notices.some((e: any) => String(e.payload?.content).includes('refunded'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Reconciliation
// ---------------------------------------------------------------------------

describe('deliberate: reconciliation', () => {
  it('compares source-of-truth counts vs dead letters and writes an audit report', async () => {
    const auditsBefore = dbState.auditLogs.length;
    const token = mark();

    await pipeline.queue.enqueue('reconciliation', {});
    await drain(pipeline, ['reconciliation']);

    expect(dbState.auditLogs.length).toBe(auditsBefore + 1);
    const audit = dbState.auditLogs[dbState.auditLogs.length - 1];
    expect(audit.action).toBe('reconciliation');
    const report = JSON.parse(audit.details ?? '{}');
    expect(typeof report.neon).toBe('object');
    expect(typeof report.redis.deadLetters).toBe('object');
    expect(report.generatedAt).toBeTruthy();

    const reconciles = busEventsAfter(token);
    expect(reconciles.some((e: any) => e.decisionReason === 'reconciliation_completed')).toBe(true);
  });

  it('is resilient when the database is down, but cannot detect drift (documented)', async () => {
    dbState.failEventWrites = true;
    dbState.failAuditWrites = true;
    try {
      const auditsBefore = dbState.auditLogs.length;
      const token = mark();
      await pipeline.queue.enqueue('reconciliation', {});
      await drain(pipeline, ['reconciliation']);

      // No audit row, but the report is still emitted with empty Neon, and the
      // job completed rather than crashing.
      expect(dbState.auditLogs.length).toBe(auditsBefore);
      const reconciles = busEventsAfter(token);
      expect(reconciles.some((e: any) => e.decisionReason === 'reconciliation_completed')).toBe(true);
      console.warn(
        '[gap] reconciliation cannot act as a durable audit while Neon is down, and it never reconciles against provider-reported transactions',
      );
    } finally {
      dbState.failEventWrites = false;
      dbState.failAuditWrites = false;
    }
  });
});