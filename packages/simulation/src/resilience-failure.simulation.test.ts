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

console.warn('\n[audit] AUDIT 5 — Resilience, Load & Failure Engineering\n');

// Avoid a crashing rejection when the failing-store worker loop dies (R2).
let unhandledRejections = 0;
process.on('unhandledRejection', () => {
  unhandledRejections++;
});

const AUTH = {
  authorization: 'Bearer ' + API_KEY,
  'x-tenant-id': TENANT_ID,
};

const ALL_PROVIDERS = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'stripe', 'nmi', 'email'];

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
// R4) All SMS providers offline — silent channel change (GAP)
// ---------------------------------------------------------------------------

describe('R4 — all SMS providers offline: silent channel change (GAP)', () => {
  it('an SMS is silently routed over email when no SMS provider is available', async () => {
    const sms = ['signalhouse', 'infobip', 'futuresms', 'example-msg'];
    for (const p of sms) runtime.registry.updateManagement(p, { status: 'offline' });
    try {
      const res = await sendMessage(runtime, { recipient: '+15550003333', content: 'x' }, AUTH);
      expect(res.status).toBe(200);
      expect(res.body.providerId).toBe('email');
      console.warn(
        '[GAP] when all SMS providers are offline, an SMS is silently routed over email (channel changed without alert)',
      );
    } finally {
      for (const p of sms) runtime.registry.updateManagement(p, { status: 'online' });
    }
  });
});

// ---------------------------------------------------------------------------
// R5) Infobip returns error — failover + 503 (OK)
// ---------------------------------------------------------------------------

describe('R5 — single provider failover then hard 503 (OK)', () => {
  it('fails over on one provider error and returns 503 when all fail', async () => {
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

    // signalhouse is online by default -> single failover target.
    const first = await sendMessage(
      runtime,
      { recipient: DONOR_PHONE, content: 'x', providerOverride: 'infobip' },
      AUTH,
    );
    expect(first.status).toBe(200);
    expect(first.body.providerId).not.toBe('infobip');

    // Now also break signalhouse -> nothing left -> 503.
    const signalhouse = runtime.registry.getProvider('signalhouse') as unknown as {
      processRequest: (...a: any[]) => Promise<any>;
    };
    const origSig = signalhouse.processRequest.bind(signalhouse);
    signalhouse.processRequest = async () => {
      throw new Error('down');
    };
    patches.push(() => {
      signalhouse.processRequest = origSig;
    });

    const second = await sendMessage(
      runtime,
      { recipient: DONOR_PHONE, content: 'x', providerOverride: 'infobip' },
      AUTH,
    );
    expect(second.status).toBe(503);
    console.warn('[OK] single-provider failover and hard-failure 503 both work');
  });
});

// ---------------------------------------------------------------------------
// R6) Stripe timeout / hang — no server-side timeout (DEFECT)
// ---------------------------------------------------------------------------

describe('R6 — provider hang: no gateway request timeout (DEFECT)', () => {
  it('a hung provider stalls the gateway request indefinitely', async () => {
    const stripe = runtime.registry.getProvider('stripe') as unknown as {
      processRequest: (...a: any[]) => Promise<any>;
    };
    const orig = stripe.processRequest.bind(stripe);
    stripe.processRequest = async () => new Promise(() => {}); // never resolves
    patches.push(() => {
      stripe.processRequest = orig;
    });

    const result = await Promise.race([
      createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH).then(() => 'done'),
      sleep(1500).then(() => 'hung'),
    ]);

    // DEFECT: no request timeout around provider call. A hung provider stalls
    // the gateway request indefinitely. Documenting current behavior.
    expect(result).toBe('hung');
    console.warn(
      '[DEFECT] no request timeout around provider call: a hung provider stalls the gateway request indefinitely',
    );
  });
});

// ---------------------------------------------------------------------------
// R7) Provider returns success but connection drops (GAP / OK)
// ---------------------------------------------------------------------------

describe('R7 — success then connection drop (GAP)', () => {
  it('a "success then drop" is treated as failure (no silent double charge)', async () => {
    const stripe = runtime.registry.getProvider('stripe') as unknown as {
      processRequest: (...a: any[]) => Promise<any>;
    };
    const orig = stripe.processRequest.bind(stripe);
    stripe.processRequest = async (appId: string, payload: any, decisionReason: string) => {
      const evt = {
        id: 'chg_ok1',
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: 'stripe',
        status: 'success',
        latency: 10,
        cost: 0,
        decisionReason: 'approved',
        payload,
        response: null,
      };
      // Simulate the connection dropping after the provider returned success.
      throw new Error('ECONNRESET after success');
    };
    patches.push(() => {
      stripe.processRequest = orig;
    });

    const res = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    // Safe: treated as failure (failover/503), never a silent double charge.
    expect(res.status === 503 || res.body.providerId !== 'stripe').toBe(true);
    console.warn(
      '[GAP] a "success then drop" is treated as failure (safe vs double-charge) but there is no at-least-once retry guarantee',
    );
  });
});

// ---------------------------------------------------------------------------
// R8) Worker crash during payment processing — retry + idempotency (OK)
// ---------------------------------------------------------------------------

describe('R8 — worker crash mid-emit: idempotency bounds duplicates (OK)', () => {
  it('idempotency (setNx) prevents a duplicate payment record even after a crash+retry', async () => {
    // The payment_webhook processor claims the idempotency key (setNx) BEFORE
    // doing the durable write and the downstream emit. If the worker crashes
    // after claiming the key, any retry/replay with the same webhook id sees the
    // key already set and is blocked by the guard — so a second durable record
    // can never be created (no double charge).
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

    // First processing: setNx ok, durable row written, downstream emit crashes.
    const e1 = envelope();
    const job1 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: e1.rawBody,
      signature: e1.signature,
      id: 'chg_crash1',
    });
    // The emit crash causes the job to fail. On retry, idempotency blocks it → dead.
    await waitFor(
      async () => {
        const j = await pipeline.queue.getJob(job1.id);
        return j?.status === 'dead';
      },
      { label: 'R8 first job dead after crash+idempotency block', timeoutMs: 30_000 },
    );
    expect(dbState.events.filter((r) => r.category === 'payment_webhook').length).toBe(
      rowsBefore + 1,
    );

    // Simulate the post-crash retry: the same webhook id is replayed.
    const e2 = envelope();
    const job2 = await enqueuePaymentWebhook(pipeline.queue, {
      appId: APP_SLUG,
      providerId: 'stripe',
      rawBody: e2.rawBody,
      signature: e2.signature,
      id: 'chg_crash1',
    });
    await waitFor(
      async () => (await pipeline.queue.getJob(job2.id))?.status === 'dead',
      { label: 'R8 replay dead' },
    );

    const finalJob = await pipeline.queue.getJob(job2.id);
    expect(finalJob?.status).toBe('dead');
    expect(finalJob?.lastError).toContain('Replay detected');
    // Still exactly one row — the replay was blocked, no duplicate payment.
    expect(dbState.events.filter((r) => r.category === 'payment_webhook').length).toBe(
      rowsBefore + 1,
    );
    console.warn(
      '[OK] idempotency (setNx) prevents a duplicate payment record even when a worker crashes mid-emit and retries',
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

describe('R10 — mass enqueue: no backpressure, rate-limit storm (GAP)', () => {
  it(
    'exceeding the rate limit turns into a retry/dead-letter storm',
    async () => {
      const w = await runtime.makeWorker({
        config: {
          ...DEFAULT_WORKER_CONFIG,
          rateLimit: { windowMs: 60_000, maxRequests: 100 },
        },
      });

    const LOAD = 5000;
    for (let i = 0; i < LOAD; i++) {
      await w.queue.enqueue('message_delivery', {
        appId: APP_SLUG,
        recipient: DONOR_EMAIL,
        content: `m${i}`,
      });
    }

    await drain(w, ['message_delivery'], { timeoutMs: 120_000 });
    const c = await counts(w, 'message_delivery');

    // EXPECTED-SAFE: the system should apply backpressure instead of converting
    // overflow into a retry/dead-letter storm. Here dead letters pile up.
    expect(c.dead).toBeGreaterThan(0);
    console.warn(
      `[GAP] no producer backpressure; exceeding the rate limit turns into a retry/dead-letter storm (count(dead)=${c.dead})`,
    );
    await w.manager.stop().catch(() => {});
    },
    180_000,
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
