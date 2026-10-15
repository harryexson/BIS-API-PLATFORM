import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { dbState, clearDb, seedReachChurch, installDatabaseMock } from './db';

vi.mock('@company/database', () => installDatabaseMock());

import { QueueBackpressureError, JobQueue, createWorkerConfig, type JobType } from '@company/workers';
import {
  createSimulation,
  buildStripeWebhook,
  signWebhook,
  waitFor,
  stopWorker,
  DEFAULT_WORKER_CONFIG,
  type SimRuntime,
  type WorkerHandle,
} from './harness';

/**
 * Phase 4 — the REAL gateway route (POST /v1/api/webhooks/:provider over
 * HTTP) follows the 10-step pipeline and acknowledges only what is durably
 * recorded and enqueued (gap register B8/C5/D7), and the worker's durable
 * consumer state lets a transient failure retry cleanly (B5, the Phase-0
 * "probe3" reproduction).
 *
 * The database here is the in-memory double (./db.ts); the same SQL against
 * a real Postgres — including the unique index that is the real
 * enforcement point — is proven in packages/database/src/
 * webhook-events.postgres.integration.test.ts and
 * webhook-pipeline.postgres.integration.test.ts.
 */

let runtime: SimRuntime;
const patches: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

afterEach(() => {
  while (patches.length) patches.pop()?.();
  dbState.failWebhookEventStore = false;
  dbState.failEventWrites = false;
});

async function post(provider: string, body: unknown, opts: { signature?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const res = await runtime.postText(`/v1/api/webhooks/${provider}`, rawBody, {
    'x-webhook-signature': opts.signature ?? signWebhook(rawBody),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function gatewayJobs(type: JobType, webhookEventId: string) {
  const ids = await runtime.gatewayStore.lrange(runtime.gatewayKeys.ready(type), 0, -1);
  const queue = new JobQueue(runtime.gatewayStore, runtime.gatewayKeys, { ...createWorkerConfig(), ...DEFAULT_WORKER_CONFIG });
  const jobs = await Promise.all(ids.map((id) => queue.getJob(id)));
  return jobs.filter((j) => j?.payload.webhookEventId === webhookEventId);
}

const rowsFor = (providerId: string, providerEventId: string) =>
  dbState.webhookEvents.filter((e) => e.providerId === providerId && e.providerEventId === providerEventId);

describe('gateway: persist → enforce uniqueness → enqueue → acknowledge', () => {
  it('10 concurrent identical deliveries over HTTP → one durable row, one job of each type, one non-duplicate 200', async () => {
    const body = buildStripeWebhook('ch_conc', { id: 'evt_http_concurrent' });
    const results = await Promise.all(Array.from({ length: 10 }, () => post('stripe', body)));

    const fresh = results.filter((r) => r.status === 200 && !r.json.duplicate);
    expect(fresh).toHaveLength(1);
    for (const r of results) {
      // duplicate → 200 (already recorded+enqueued); in flight → 503 (retry later)
      expect(r.status === 200 || (r.status === 503 && r.json.error?.includes('concurrent delivery'))).toBe(true);
    }
    const rows = rowsFor('stripe', 'evt_http_concurrent');
    expect(rows).toHaveLength(1);
    expect(fresh[0].json.webhookEventId).toBe(rows[0].id);
    for (const type of ['inbound_message', 'payment_webhook', 'provider_webhook'] as const) {
      expect(await gatewayJobs(type, rows[0].id)).toHaveLength(1);
    }
  });

  it('the same event id from two different providers is two different durable events', async () => {
    const body = buildStripeWebhook('ch_x', { id: 'evt_shared_id' });
    expect((await post('stripe', body)).json.duplicate).toBeUndefined();
    const other = await post('signalhouse', body);
    expect(other.status).toBe(200);
    expect(other.json.duplicate).toBeUndefined();
    expect(rowsFor('stripe', 'evt_shared_id')).toHaveLength(1);
    expect(rowsFor('signalhouse', 'evt_shared_id')).toHaveLength(1);
  });

  it('durable persist failure → 503 (never acknowledged), nothing enqueued; the provider retry then succeeds', async () => {
    const body = buildStripeWebhook('ch_dbdown', { id: 'evt_db_down' });
    dbState.failWebhookEventStore = true;
    const down = await post('stripe', body);
    expect(down.status).toBe(503);
    expect(rowsFor('stripe', 'evt_db_down')).toHaveLength(0);

    dbState.failWebhookEventStore = false;
    const retry = await post('stripe', body);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBeUndefined();
    expect(await gatewayJobs('payment_webhook', retry.json.webhookEventId)).toHaveLength(1);
  });

  it('enqueue failure (queue backpressure / Redis down) → 503 with the row kept; the retry recovers it exactly once', async () => {
    const { queue } = await (
      (await import('../../../services/api-gateway/src/app')) as unknown as {
        getGatewayQueueForTests(): Promise<{ queue: JobQueue }>;
      }
    ).getGatewayQueueForTests();
    const original = queue.enqueue.bind(queue);
    let calls = 0;
    queue.enqueue = (async (type: JobType, payload: Record<string, unknown>) => {
      // Let inbound_message through, fail payment_webhook — a partial enqueue.
      calls++;
      if (type === 'payment_webhook') throw new QueueBackpressureError(type, 10_000, 10_000);
      return original(type, payload);
    }) as JobQueue['enqueue'];
    patches.push(() => {
      queue.enqueue = original;
    });

    const body = buildStripeWebhook('ch_enq', { id: 'evt_enqueue_fail' });
    const failed = await post('stripe', body);
    expect(failed.status).toBe(503);
    expect(calls).toBe(2);
    const [row] = rowsFor('stripe', 'evt_enqueue_fail');
    expect(row.enqueuedAt).toBeNull();
    expect(row.enqueuedJobs).toEqual(['inbound_message']);

    queue.enqueue = original;
    const retry = await post('stripe', body);
    expect(retry.status).toBe(200);
    expect(retry.json.webhookEventId).toBe(row.id);
    const again = await post('stripe', body);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);

    // inbound_message was NOT re-sent by the recovery; the others went out once.
    for (const type of ['inbound_message', 'payment_webhook', 'provider_webhook'] as const) {
      expect(await gatewayJobs(type, row.id)).toHaveLength(1);
    }
  });

  it('a payload without a provider event id is rejected 400 (no durable identity) and never stored', async () => {
    const before = dbState.webhookEvents.length;
    const body = { type: 'charge.succeeded', data: { object: { id: 'ch_noid' } } };
    const res = await post('stripe', body);
    expect(res.status).toBe(400);
    expect(dbState.webhookEvents.length).toBe(before);
  });

  it('signature is checked before anything is stored; unknown provider is rejected after authentication', async () => {
    const before = dbState.webhookEvents.length;
    const forged = await post('stripe', buildStripeWebhook('ch_f', { id: 'evt_forged' }), { signature: 'ab'.repeat(32) });
    expect(forged.status).toBe(401);
    const unknown = await post('evilcorp', buildStripeWebhook('ch_e', { id: 'evt_evil' }));
    expect(unknown.status).toBe(401);
    expect(dbState.webhookEvents.length).toBe(before);
  });
});

describe('worker: durable consumer state (B5 / Phase-0 probe3)', () => {
  let worker: WorkerHandle;

  afterAll(async () => {
    if (worker) await stopWorker(worker);
  });

  it('a payment webhook whose first DB write fails is retried to completion — not dead-lettered as "Replay detected"', async () => {
    const body = buildStripeWebhook('ch_probe3', { id: 'evt_probe3' });
    dbState.failEventWrites = true; // the consumer's durable write fails…
    const res = await post('stripe', body);
    expect(res.status).toBe(200);
    const eventId: string = res.json.webhookEventId;

    // Real worker attached to the exact store the gateway enqueued into.
    // Backoff long enough that the retry cannot exhaust before the DB recovers.
    worker = await runtime.makeWorker({
      store: runtime.gatewayStore,
      keys: runtime.gatewayKeys,
      config: { retry: { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 300, factor: 2, maxDeadRetries: 0 } },
    });
    await waitFor(
      () => dbState.webhookEventConsumers.some((c) => c.webhookEventId === eventId && c.consumer === 'payment_webhook' && c.status === 'failed'),
      { label: 'first attempt recorded as failed', everyMs: 5 },
    );
    dbState.failEventWrites = false; // …then the DB recovers.

    await waitFor(() => dbState.webhookEvents.find((e) => e.id === eventId)?.status === 'processed', {
      label: 'event processed after retry',
    });
    const payment = dbState.webhookEventConsumers.find((c) => c.webhookEventId === eventId && c.consumer === 'payment_webhook')!;
    expect(payment.status).toBe('processed');
    expect(payment.attempts).toBeGreaterThanOrEqual(2);
    expect(dbState.events.filter((e) => e.idempotencyKey === `webhook:${eventId}:payment_webhook`)).toHaveLength(1);

    // Nothing for this event was dead-lettered.
    const dead = await Promise.all((await worker.queue.deadJobs('payment_webhook')).map((id) => worker.queue.getJob(id)));
    expect(dead.filter((j) => j?.payload.webhookEventId === eventId)).toHaveLength(0);
  });
});

describe('billing webhook (/v1/api/billing/webhooks/stripe): same durable identity', () => {
  const SECRET = 'whsec_sim_billing_phase4';

  async function postBilling(event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    const res = await runtime.postText('/v1/api/billing/webhooks/stripe', raw, { 'stripe-signature': `t=${t},v1=${v1}` });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  it('processes once, acknowledges a redelivery as a duplicate, and lets a failed attempt retry', async () => {
    const prev = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
    patches.push(() => {
      if (prev === undefined) delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
      else process.env.STRIPE_BILLING_WEBHOOK_SECRET = prev;
    });
    const event = { id: 'evt_billing_p4', type: 'invoice.created', data: { object: { id: 'in_1' } } };

    dbState.failWebhookEventStore = true;
    expect((await postBilling(event)).status).toBe(500); // not durably recorded → not acknowledged
    dbState.failWebhookEventStore = false;

    const first = await postBilling(event);
    expect(first.status).toBe(200);
    expect(first.json.duplicate).toBeUndefined();
    const second = await postBilling(event);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);

    const rows = rowsFor('stripe-billing', 'evt_billing_p4');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('processed');
    const consumer = dbState.webhookEventConsumers.find((c) => c.webhookEventId === rows[0].id);
    expect(consumer?.consumer).toBe('billing_sync');
    expect(consumer?.attempts).toBe(1);
    expect(await gatewayJobs('payment_webhook', rows[0].id)).toHaveLength(0); // processed inline, never queued

    expect((await postBilling({ type: 'invoice.created', data: { object: {} } })).status).toBe(400);
  });
});
