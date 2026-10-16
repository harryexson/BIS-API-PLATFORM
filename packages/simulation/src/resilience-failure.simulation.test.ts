import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import {
  dbState,
  clearDb,
  seedReachChurch,
  installDatabaseMock,
  APP_SLUG,
  API_KEY,
  TENANT_ID,
  DONOR_EMAIL,
  DONOR_PHONE,
} from './db';
import {
  createSimulation,
  createDonation,
  buildStripeWebhook,
  signWebhook,
  sendMessage,
  enqueueReceipt,
  enqueuePaymentWebhook,
  drain,
  waitFor,
  sleep,
  counts,
  stopWorker,
  createFailingStore,
  DEFAULT_WORKER_CONFIG,
  wireReceiptPipeline,
  type SimRuntime,
  type WorkerHandle,
} from './harness';
import { PROVIDER_TIMEOUT_MS } from '@company/routing';
import { QueueBackpressureError } from '@company/workers';

console.warn('\n[audit] AUDIT 5 — Resilience, Load & Failure Engineering\n');

// Every SMS-capable provider currently registered — see the identical list
// (and rationale) in messaging-conversation.simulation.test.ts. A hard
// "all providers exhausted" test must break every one of these, not just
// one or two: packages/routing/src/scoring.ts's cascade ranks and tries
// every remaining online candidate, not a single fixed fallback hop, so
// proving genuine exhaustion means genuinely exhausting the pool.
const SMS_CAPABLE = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'africastalking', 'sinch', 'vibes', 'twilio', 'vonage'];

// Avoid a crashing rejection when the failing-store worker loop dies (R2).
let unhandledRejections = 0;
process.on('unhandledRejection', () => {
  unhandledRejections++;
});

const AUTH = {
  authorization: 'Bearer ' + API_KEY,
  'x-tenant-id': TENANT_ID,
};

const ALL_PROVIDERS = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'twilio', 'stripe', 'nmi', 'email'];

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
  // Restore provider management states so a failed test cannot leak state.
  for (const p of ALL_PROVIDERS) {
    try {
      runtime.registry.updateManagement(p, { status: 'online' });
    } catch {
      /* provider may not exist in this registry snapshot */
    }
  }
  dbState.failEventWrites = false;
  dbState.failAuditWrites = false;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mark(): number {
  return Date.now() - 1;
}

function busEventsAfter(token: number, category?: string, providerId?: string) {
  return runtime.bus
    .getHistory()
    .filter((e: any) => new Date(e.timestamp).getTime() >= token)
    .filter((e: any) => (category ? e.category === category : true))
    .filter((e: any) => (providerId ? e.providerId === providerId : true));
}

function patchProvider(
  providerId: string,
  impl: (appId: string, payload: any, decisionReason: string) => Promise<any>,
) {
  const provider = runtime.registry.getProvider(providerId) as unknown as {
    processRequest: (appId: string, payload: any, decisionReason: string) => Promise<any>;
  };
  const original = provider.processRequest.bind(provider);
  provider.processRequest = impl as any;
  patches.push(() => {
    provider.processRequest = original;
  });
}

// ---------------------------------------------------------------------------
// R1) DB unavailable — silent data loss (DEFECT)
// ---------------------------------------------------------------------------

describe('R1 — DB unavailable: data loss now triggers retry (FIXED)', () => {
  it('a failed DB write causes the job to retry and dead-letter (no silent data loss)', async () => {
    dbState.failEventWrites = true;
    const rowsBefore = dbState.events.length;
    const job = await enqueueReceipt(pipeline.queue, {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'x',
    });
    // P1 FIX: DB write failure now causes the job to retry, then dead-letter
    await waitFor(async () => {
      const j = await pipeline.queue.getJob(job.id);
      return j?.status === 'dead';
    }, { label: 'R1 job dead-lettered after retries' });
    const finalJob = await pipeline.queue.getJob(job.id);

    // After our P1 fix: DB write failure causes retry + dead-letter,
    // not silent completion with data loss.
    expect(finalJob?.status).toBe('dead');
    expect(dbState.events.length).toBe(rowsBefore); // no row written (DB was failing)
    console.warn('[FIXED] DB write failure now triggers retry/dead-letter — no silent data loss');
  });
});

// ---------------------------------------------------------------------------
// R2) Redis / backing store unavailable (DEFECT)
// ---------------------------------------------------------------------------

describe('R2 — backing store unavailable: worker poll loop dies', () => {
  it('a dead store kills the worker with no recovery/circuit-breaker (DEFECT)', async () => {
    unhandledRejections = 0;
    const store = createFailingStore();
    const w = await runtime.makeWorker({ store });

    const beforeBus = runtime.bus.getHistory().length;
    let enqueueThrew = false;
    try {
      await w.queue.enqueue('message_delivery', {
        appId: APP_SLUG,
        recipient: DONOR_EMAIL,
        content: 'x',
      });
    } catch {
      enqueueThrew = true;
    }
    await sleep(250);
    const afterBus = runtime.bus.getHistory().length;

    // DEFECT: the worker poll loop dies with an unhandled rejection when the
    // backing store fails. No circuit-breaker, no recovery. Documenting current behavior.
    expect(unhandledRejections).toBeGreaterThan(0); // confirmed: loop death throws unhandled rejection
    expect(afterBus).toBe(beforeBus); // no processing occurred (loop died)
    expect(enqueueThrew).toBe(true); // producer cannot even enqueue

    await w.manager.stop().catch(() => {});
    console.warn(
      '[DEFECT] backing-store failure kills the worker poll loop with no recovery/circuit-breaker; in-flight jobs halt',
    );
  });
});

// ---------------------------------------------------------------------------
// R3) SignalHouse unavailable — failover works (OK)
// ---------------------------------------------------------------------------

describe('R3 — primary SMS provider offline: failover works (OK)', () => {
  it('routes to a healthy backup provider when the primary is offline', async () => {
    runtime.registry.updateManagement('signalhouse', { status: 'offline' });
    const res = await sendMessage(runtime, { recipient: DONOR_PHONE, content: 'x' }, AUTH);
    expect(res.status).toBe(200);
    expect(res.body.providerId).not.toBe('signalhouse');
    console.warn('[OK] provider failover works when primary is offline');
  });
});

// ---------------------------------------------------------------------------
// R4) All SMS providers offline — NO silent channel change (FIXED, Phase 10)
// ---------------------------------------------------------------------------

describe('R4 — all SMS providers offline: no silent channel change (FIXED, Phase 10)', () => {
  it('an SMS fails with a specific channel_unavailable reason instead of being silently routed over email', async () => {
    // Phase 10 (gap register A9): this test used to assert the defect
    // (`res.status === 200 && providerId === 'email'` for an SMS). It now
    // asserts the corrected, observable behaviour for both an inferred-sms
    // caller (no channel field) and an explicit channel:'sms' caller.
    const sms = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'twilio', 'whatsapp', 'vonage', 'africastalking', 'sinch', 'vibes'];
    for (const p of sms) runtime.registry.updateManagement(p, { status: 'offline' });
    try {
      for (const body of [
        { recipient: '+15550003333', content: 'x' },
        { recipient: '+15550003333', content: 'x', channel: 'sms' },
      ]) {
        const res = await sendMessage(runtime, body, AUTH);
        expect(res.status).toBe(503);
        expect(res.body.providerId).toBeUndefined();
        expect(res.body).toMatchObject({
          code: 'channel_unavailable',
          requestedChannel: 'sms',
          requestedChannelSource: body.channel ? 'explicit' : 'inferred',
          selectedChannel: null,
          fallbackReason: null,
        });
        expect(String(res.body.detail)).toContain('allowChannelSwitch');
      }
      console.warn('[FIXED] when all SMS providers are offline, an SMS fails loudly (channel_unavailable) instead of silently going out as email');
    } finally {
      for (const p of sms) runtime.registry.updateManagement(p, { status: 'online' });
    }
  });
});

// ---------------------------------------------------------------------------
// R5) Infobip returns error — failover + 503 (OK)
// ---------------------------------------------------------------------------

describe('R5 — single provider failover then hard 503 (OK)', () => {
  it('fails over on one provider error and returns 503 once every SMS-capable provider is broken', async () => {
    const infobip = runtime.registry.getProvider('infobip') as unknown as {
      processRequest: (...a: any[]) => Promise<any>;
    };
    const origInfo = infobip.processRequest.bind(infobip);
    infobip.processRequest = async () => {
      throw new Error('429');
    };
    patches.push(() => {
      infobip.processRequest = origInfo;
    });

    // Several other SMS providers are still online -> failover succeeds to
    // some other real SMS-capable provider (the specific winner is scored,
    // not a fixed "first in list" pick).
    const first = await sendMessage(
      runtime,
      { recipient: DONOR_PHONE, content: 'x', providerOverride: 'infobip' },
      AUTH,
    );
    expect(first.status).toBe(200);
    expect(first.body.providerId).not.toBe('infobip');
    expect(SMS_CAPABLE).toContain(first.body.providerId);

    // Now break every remaining SMS-capable provider — the routing engine
    // cascades through every remaining ranked candidate (not a single fixed
    // fallback hop), so proving genuine exhaustion means genuinely
    // exhausting the pool, not just breaking one more.
    for (const id of SMS_CAPABLE) {
      if (id === 'infobip') continue;
      const provider = runtime.registry.getProvider(id) as unknown as {
        processRequest: (...a: any[]) => Promise<any>;
      };
      const original = provider.processRequest.bind(provider);
      provider.processRequest = async () => {
        throw new Error('down');
      };
      patches.push(() => {
        provider.processRequest = original;
      });
    }

    const second = await sendMessage(
      runtime,
      { recipient: DONOR_PHONE, content: 'x', providerOverride: 'infobip' },
      AUTH,
    );
    expect(second.status).toBe(503);
    console.warn('[OK] single-provider failover and hard-failure 503 (once the whole SMS pool is exhausted) both work');
  });
});

// ---------------------------------------------------------------------------
// R6) Stripe timeout / hang — no server-side timeout (DEFECT)
// ---------------------------------------------------------------------------

describe('R6 — provider hang: gateway request timeout, ambiguous outcome not retried (FIXED)', () => {
  it(
    'a hung PAYMENT provider is timed out after PROVIDER_TIMEOUT_MS and returned as an ambiguous 202, never retried via another provider',
    async () => {
      const stripe = runtime.registry.getProvider('stripe') as unknown as {
        processRequest: (...a: any[]) => Promise<any>;
      };
      const orig = stripe.processRequest.bind(stripe);
      stripe.processRequest = async () => new Promise(() => {}); // never resolves
      patches.push(() => {
        stripe.processRequest = orig;
      });

      // packages/routing/src/index.ts already wraps every provider call in
      // withProviderTimeout(), which was never actually being exercised by
      // this test — 1500ms is far shorter than the real PROVIDER_TIMEOUT_MS
      // (30s default), so it always looked "hung" without ever reaching the
      // real timeout. Race against the real value instead of an arbitrary
      // short window that can't distinguish "hung" from "just slow so far".
      const result = await Promise.race([
        createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH).then((r) => ({ done: true, status: r.status, providerId: r.body.providerId as string | undefined, eventStatus: r.body.status as string | undefined, id: r.body.id as string | undefined, paymentTransactionId: r.body.paymentTransactionId as string | undefined })),
        sleep(PROVIDER_TIMEOUT_MS + 5000).then(() => ({ done: false, status: undefined as number | undefined, providerId: undefined as string | undefined, eventStatus: undefined as string | undefined, id: undefined as string | undefined, paymentTransactionId: undefined as string | undefined })),
      ]);

      expect(result.done).toBe(true);
      // A PAYMENT timeout is genuinely ambiguous — the charge may have
      // reached Stripe and succeeded before the response was lost, so
      // packages/routing/src/index.ts's routePayment() deliberately does
      // NOT cascade to another provider on a timeout (unlike a soft
      // decline or thrown error, which do cascade) — retrying here risks
      // a real double charge. It returns the timed-out provider's own id
      // with status 'unknown' (202) instead, leaving reconciliation via
      // webhook/status-check as the only safe next step. See the
      // ProviderTimeoutError branch in routePayment for the full
      // reasoning.
      expect(result.status).toBe(202);
      expect(result.eventStatus).toBe('unknown');
      expect(result.providerId).toBe('stripe');
      // Phase 6 (D4): identified by the platform's own pre-allocated payment
      // transaction id, stored in the distinct 'unknown' status with no
      // (random) provider id — so the provider's later webhook, the
      // reconciliation job, or an operator can resolve it.
      expect(result.id).toBe(result.paymentTransactionId);
      const row = dbState.transactions.find((t) => t.id === result.paymentTransactionId)!;
      expect(row.status).toBe('unknown');
      expect(row.providerTransactionId).toBeNull();
      console.warn(
        `[FIXED] hung provider timed out after ${PROVIDER_TIMEOUT_MS}ms and was returned as an ambiguous 'unknown' (202) rather than stalling indefinitely or risking a double charge via blind failover`,
      );
    },
    PROVIDER_TIMEOUT_MS + 15_000,
  );
});

// ---------------------------------------------------------------------------
// R7) Provider returns success but connection drops (FIXED, Phase 11-12)
// ---------------------------------------------------------------------------

describe('R7 — success then connection drop: ambiguous, never failed over (FIXED, Phase 11-12)', () => {
  it('a "success then drop" is reported as unknown (202) on the original provider, and NO other provider is charged', async () => {
    // Phase 11-12 (gap register A10/E4/PHASE3-01): this test used to assert
    // `res.status === 503 || res.body.providerId !== 'stripe'` and call that
    // "safe" — but `providerId !== 'stripe'` IS the double charge: Stripe
    // processed the charge (the connection dropped AFTER its success), and
    // the router then charged a second provider for the same payment. It now
    // asserts the outcome is the ambiguous 'unknown' on Stripe, stored as
    // 'unknown' with no fabricated provider id (reconcilable), with zero
    // calls to any other payment provider.
    const stripe = runtime.registry.getProvider('stripe') as unknown as {
      processRequest: (...a: any[]) => Promise<any>;
    };
    const orig = stripe.processRequest.bind(stripe);
    stripe.processRequest = async () => {
      // Simulate the connection dropping after the provider returned success.
      throw new Error('ECONNRESET after success');
    };
    patches.push(() => {
      stripe.processRequest = orig;
    });
    const otherCalls: string[] = [];
    for (const cfg of runtime.registry.getAllConfigs()) {
      if (cfg.category !== 'payment' || cfg.id === 'stripe') continue;
      const p = runtime.registry.getProvider(cfg.id) as unknown as { processRequest: (...a: any[]) => Promise<any> };
      const original = p.processRequest;
      p.processRequest = async (...a: any[]) => {
        otherCalls.push(cfg.id);
        return original.apply(p, a);
      };
      patches.push(() => {
        p.processRequest = original;
      });
    }

    const res = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('unknown');
    expect(res.body.providerId).toBe('stripe');
    expect(otherCalls).toEqual([]);
    const row = dbState.transactions.find((t) => t.id === res.body.paymentTransactionId)!;
    expect(row.status).toBe('unknown');
    expect(row.providerTransactionId).toBeNull();
    console.warn('[FIXED] a "success then drop" is an ambiguous unknown (reconciled), never failed over to a second provider');
  });
});

// ---------------------------------------------------------------------------
// R8) Worker crash during payment processing — retry + idempotency (OK)
// ---------------------------------------------------------------------------

describe('R8 — worker crash mid-emit: durable consumer state bounds duplicates AND the retry completes (FIXED)', () => {
  it('a crash after the durable write is retried to completion with exactly one payment record; a later replay is a no-op', async () => {
    // Phase 4 (gap register B5). This test used to assert the OPPOSITE: that
    // after the emit crash the job went `dead` and every retry/replay failed
    // with "Replay detected" — i.e. that the webhook was permanently lost
    // (the receipt/emit never happened) because the processor set a
    // Redis/memory setNx marker BEFORE doing the work and never cleared it.
    // Now:
    //   - the consumer claim lives in webhook_event_consumers; the crash
    //     records the attempt as `failed`, and the retry cleanly re-claims it;
    //   - the events/outbox write is at-most-once per durable event
    //     (persistEffectsOnce), so the retry does NOT write a second record;
    //   - the retry's emit succeeds, so the webhook is actually processed.
    const original = runtime.bus.emit.bind(runtime.bus);
    let first = true;
    (runtime.bus as any).emit = async (e: any) => {
      if (first) {
        first = false;
        throw new Error('crash');
      }
      return original(e);
    };
    patches.push(() => {
      (runtime.bus as any).emit = original;
    });

    const rowsBefore = dbState.events.filter((r) => r.category === 'payment_webhook').length;
    const envelope = () => {
      const body = buildStripeWebhook('chg_crash1');
      const raw = JSON.stringify(body);
      return { rawBody: raw, signature: signWebhook(raw) };
    };

    // First processing: durable row written, downstream emit crashes, the
    // job is retried and completes.
    const e1 = envelope();
    const job1 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: e1.rawBody,
      signature: e1.signature,
      id: 'chg_crash1',
    });
    await waitFor(
      async () => (await pipeline.queue.getJob(job1.id))?.status === 'completed',
      { label: 'R8 first job completed after crash + clean retry', timeoutMs: 15_000 },
    );
    const job1State = await pipeline.queue.getJob(job1.id);
    expect(job1State?.attempts).toBe(1); // one failed attempt recorded, then success
    expect(dbState.events.filter((r) => r.category === 'payment_webhook').length).toBe(rowsBefore + 1);
    const durable = dbState.webhookEvents.filter((e) => e.providerId === 'stripe' && e.providerEventId === 'chg_crash1');
    expect(durable).toHaveLength(1);
    const consumer = dbState.webhookEventConsumers.find(
      (c) => c.webhookEventId === durable[0].id && c.consumer === 'payment_webhook',
    );
    expect(consumer?.status).toBe('processed');
    expect(consumer?.attempts).toBe(2);

    // A later replay of the same webhook id is a genuine replay: no-op.
    const e2 = envelope();
    const job2 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: e2.rawBody,
      signature: e2.signature,
      id: 'chg_crash1',
    });
    await waitFor(
      async () => (await pipeline.queue.getJob(job2.id))?.status === 'completed',
      { label: 'R8 replay completed as a no-op' },
    );
    const finalJob = await pipeline.queue.getJob(job2.id);
    expect(finalJob?.lastError).toBeUndefined();
    // Still exactly one row — no duplicate payment record.
    expect(dbState.events.filter((r) => r.category === 'payment_webhook').length).toBe(rowsBefore + 1);
    console.warn(
      '[FIXED] crash mid-emit: retry re-claims the durable consumer record and completes; exactly one payment record; replay is a no-op',
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R9) Webhook before DB commit — receipt without durable record (DEFECT)
// ---------------------------------------------------------------------------

describe('R9 — webhook DB write failed: now triggers retry/dead-letter (FIXED)', () => {
  it('a failed DB write now causes the webhook job to retry and dead-letter (no silent data loss)', async () => {
    dbState.failEventWrites = true;
    const rowsBefore = dbState.events.filter((r) => r.category === 'payment_webhook').length;

    const webhookBody = buildStripeWebhook('chg_r9_1');
    const rawBody = JSON.stringify(webhookBody);
    const signature = signWebhook(rawBody);
    const job = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody,
      signature,
      id: 'chg_r9_1',
    });

    // P1 FIX: DB write failure now causes the job to retry, then dead-letter
    await waitFor(
      async () => (await pipeline.queue.getJob(job.id))?.status === 'dead',
      { label: 'R9 dead-lettered after retries' },
    );

    const rowCount = dbState.events.filter((r) => r.category === 'payment_webhook').length;

    // After our P1 fix: DB write failure causes retry/dead-letter,
    // not silent completion with data loss.
    expect(rowCount).toBe(rowsBefore); // no row written (DB was failing)
    console.warn('[FIXED] webhook DB write failure now triggers retry/dead-letter — no silent data loss');
  });
});

// ---------------------------------------------------------------------------
// R10) 5,000 messages — no producer backpressure, rate-limit storms (GAP)
// ---------------------------------------------------------------------------

describe('R10 — mass enqueue: producer backpressure (FIXED)', () => {
  it(
    'JobQueue.enqueue() rejects once a job type is at capacity, instead of converting overflow into a retry/dead-letter storm',
    async () => {
      const MAX_DEPTH = 200;
      const w = await runtime.makeWorker({
        config: {
          ...DEFAULT_WORKER_CONFIG,
          rateLimit: { windowMs: 60_000, maxRequests: 100 },
          maxQueueDepth: MAX_DEPTH,
        },
      });

      // Stop the worker from draining the queue mid-test so the depth cap is
      // actually exercised — otherwise jobs complete/fail fast enough that
      // enqueue() rarely observes the queue at capacity.
      await w.manager.stop();

      const LOAD = 5000;
      let accepted = 0;
      let rejected = 0;
      for (let i = 0; i < LOAD; i++) {
        try {
          await w.queue.enqueue('message_delivery', {
            appId: APP_SLUG,
            recipient: DONOR_EMAIL,
            content: `m${i}`,
          });
          accepted++;
        } catch (err) {
          expect(err).toBeInstanceOf(QueueBackpressureError);
          rejected++;
        }
      }

      // FIXED: the queue caps at maxQueueDepth instead of silently absorbing
      // all 5000 — the producer (an HTTP route handler, a webhook enqueuer)
      // gets an immediate, actionable rejection instead of every job being
      // accepted only to fail downstream once the rate limit is hit.
      expect(accepted).toBe(MAX_DEPTH);
      expect(rejected).toBe(LOAD - MAX_DEPTH);
      expect(await counts(w, 'message_delivery')).toMatchObject({ ready: MAX_DEPTH, delayed: 0 });
      console.warn(
        `[FIXED] enqueue() rejected ${rejected}/${LOAD} jobs once "message_delivery" reached maxQueueDepth=${MAX_DEPTH}`,
      );
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// R11) Recovery after restart (OK)
// ---------------------------------------------------------------------------

describe('R11 — restart recovery reuses KVStore/keys (OK)', () => {
  it('queued work survives a restart when the same store/keys are reused', async () => {
    const w1 = await runtime.makeWorker({});
    await w1.queue.enqueue('message_delivery', {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'a',
    });
    await w1.queue.enqueue('message_delivery', {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'b',
    });
    await stopWorker(w1);

    const w2 = await runtime.makeWorker({ store: w1.store, keys: w1.keys });
    await drain(w2, ['message_delivery'], { timeoutMs: 15_000 });

    const messaging = runtime.bus
      .getHistory()
      .filter((e: any) => e.category === 'messaging');
    expect(messaging.length).toBeGreaterThanOrEqual(2);
    console.warn('[OK] restart recovery works when the same KVStore/keys are reused');
    await stopWorker(w2);
  });
});

// ---------------------------------------------------------------------------
// R12) Orphaned processing job lost after crash (DEFECT)
// ---------------------------------------------------------------------------

describe('R12 — orphaned processing job after worker death (FIXED)', () => {
  it('a job stuck in processing is rescued by the reaper on worker startup', async () => {
    const w1 = await runtime.makeWorker({});
    const job = await w1.queue.enqueue('message_delivery', {
      appId: APP_SLUG,
      recipient: DONOR_EMAIL,
      content: 'x',
    });

    // Model a worker that claimed the job (pulled off the ready queue and flipped
    // to 'processing') and then died before finishing: the job is no longer in the
    // ready list, but its status is stuck at 'processing'.
    const jobKey = w1.keys.job(job.id);
    const raw = await w1.store.get(jobKey);
    if (!raw) throw new Error('job not found in store');
    const j = JSON.parse(raw);
    j.status = 'processing';
    j.updatedAt = Date.now() - 10 * 60_000; // P1 FIX: make it stale (10 min old)
    await w1.store.set(jobKey, JSON.stringify(j), 60_000);
    await w1.store.lrem(w1.keys.ready('message_delivery'), job.id);
    await stopWorker(w1);

    const w2 = await runtime.makeWorker({ store: w1.store, keys: w1.keys });
    // P1 FIX: the reaper runs on startup and rescues stale processing jobs
    await waitFor(async () => {
      const after = await w2.queue.getJob(job.id);
      return after?.status === 'completed' || after?.status === 'dead';
    }, { label: 'R12 rescued job processed', timeoutMs: 5_000 });
    const after = await w2.queue.getJob(job.id);

    // After our P1 fix: the reaper rescues stuck jobs on startup
    expect(['completed', 'dead']).toContain(after?.status);
    console.warn('[FIXED] orphaned processing job is now rescued by the reaper on worker startup');
    await stopWorker(w2);
  });
});
