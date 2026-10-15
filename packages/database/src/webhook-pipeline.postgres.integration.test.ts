import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createWebhookEventRepository, type WebhookEventRepository } from './repositories/webhook-events';
import {
  createStore,
  createKeys,
  createWorkerConfig,
  JobQueue,
  MemoryStore,
  RedisStore,
  QueueBackpressureError,
  WorkerManager,
  DistributedLock,
  RateLimiter,
  createPaymentWebhookProcessor,
  createProviderWebhookProcessor,
  ingestWebhook,
  recoverStrandedWebhookEvents,
  type KVStore,
  type Keys,
  type WorkerConfig,
  type WebhookIngestInput,
  type WebhookIngestOutcome,
  type JobDeps,
} from '@company/workers';
import { EventBus } from '@company/events';
import { redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Phase 4 end-to-end proof of the 10-step webhook pipeline's durable half
 * (persist → enforce uniqueness → enqueue → [ack] → worker processing),
 * against a REAL PostgreSQL server and — when a redis-server binary or
 * TEST_REDIS_URL is available — a REAL Redis:
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/webhook-pipeline.postgres.integration.test.ts
 *
 * The gateway's route (services/api-gateway/src/app.ts) calls exactly the
 * `ingestWebhook` exercised here; the worker runs exactly these processors.
 * Only the drizzle handle differs from production (postgres-js instead of
 * neon-http — same SQL).
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SECRET = 'phase4-webhook-secret';
const run = promisify(execFile);

function sign(raw: string): string {
  return createHmac('sha256', SECRET).update(raw).digest('hex');
}

function delivery(providerEventId: string, type = 'charge.succeeded', providerId = 'stripe'): WebhookIngestInput {
  const body = { id: providerEventId, type, data: { object: { id: `ch_${providerEventId}` } } };
  const rawBody = JSON.stringify(body);
  return { providerId, providerEventId, appId: null, tenantId: null, eventType: type, payload: body, rawBody, signature: sign(rawBody) };
}

async function waitFor(pred: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!ADMIN_URL)('Phase 4 — webhook pipeline end-to-end (real Postgres' + (redisAvailable ? ' + real Redis)' : ')'), () => {
  let admin: ReturnType<typeof postgres>;
  const dbName = `bis_p4e2e_${randomBytes(6).toString('hex')}`;
  let dbUrl: string;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let repo: WebhookEventRepository;
  let redis: TestRedis | undefined;
  const pools: Array<ReturnType<typeof postgres>> = [];
  const stores: KVStore[] = [];
  const managers: WorkerManager[] = [];
  let prevSecret: string | undefined;

  function replicaRepo(max = 4): WebhookEventRepository {
    const c = postgres(dbUrl, { max, onnotice: () => {} });
    pools.push(c);
    const d = drizzle(c);
    return createWebhookEventRepository(() => d as never);
  }

  const config: WorkerConfig = {
    ...createWorkerConfig(),
    concurrency: 2,
    pollIntervalMs: 10,
    maxQueueDepth: 0,
    retry: { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 50, factor: 2, maxDeadRetries: 0 },
  };

  /**
   * A store for one "process". With Redis available (B1 fixed) every call
   * opens its OWN connection via the production createStore(); without it,
   * one MemoryStore per key prefix stands in for the shared Redis.
   */
  const sharedMemory = new Map<string, MemoryStore>();
  async function storeFor(keys: Keys): Promise<KVStore> {
    if (redis) {
      const store = await createStore(redis.url);
      stores.push(store);
      return store;
    }
    const k = keys.ready('');
    if (!sharedMemory.has(k)) sharedMemory.set(k, new MemoryStore());
    return sharedMemory.get(k)!;
  }

  async function newQueue(keys: Keys): Promise<{ queue: JobQueue; store: KVStore }> {
    const store = await storeFor(keys);
    return { queue: new JobQueue(store, keys, config), store };
  }

  async function jobsFor(queue: JobQueue, store: KVStore, keys: Keys, type: 'payment_webhook' | 'provider_webhook' | 'inbound_message', webhookEventId: string) {
    const ids = await store.lrange(keys.ready(type), 0, -1);
    const jobs = await Promise.all(ids.map((id) => queue.getJob(id)));
    return jobs.filter((j) => j?.payload.webhookEventId === webhookEventId);
  }

  async function startWorker(keys: Keys, webhookEvents: JobDeps['webhookEvents']) {
    const store = await storeFor(keys);
    const manager = new WorkerManager(store, keys, config);
    const deps = {
      registry: { updateManagement: () => undefined } as unknown as JobDeps['registry'],
      routing: {} as JobDeps['routing'],
      eventBus: EventBus.getInstance(),
      lock: new DistributedLock(store, keys),
      rateLimiter: new RateLimiter(store, keys, config.rateLimit),
      config,
      keys,
      webhookEvents,
    } satisfies JobDeps;
    manager.register('payment_webhook', createPaymentWebhookProcessor(deps));
    manager.register('provider_webhook', createProviderWebhookProcessor(deps));
    await manager.start();
    managers.push(manager);
    return { manager, store };
  }

  beforeAll(async () => {
    prevSecret = process.env.WEBHOOK_HMAC_SECRET;
    process.env.WEBHOOK_HMAC_SECRET = SECRET;
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    client = postgres(dbUrl, { max: 10, onnotice: () => {} });
    db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = createWebhookEventRepository(() => db as never);
    if (redisAvailable) redis = await startTestRedis();
  }, 30_000);

  afterAll(async () => {
    for (const m of managers) await m.stop();
    for (const s of stores) await s.quit?.();
    await redis?.stop();
    for (const p of pools) await p.end({ timeout: 5 });
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
    if (prevSecret === undefined) delete process.env.WEBHOOK_HMAC_SECRET;
    else process.env.WEBHOOK_HMAC_SECRET = prevSecret;
  });

  it('uses a real RedisStore for the queue when Redis is available (B1)', async () => {
    if (!redis) return; // documented: memory-only run when no redis-server exists
    const { store } = await newQueue(createKeys('p4-probe'));
    expect(store).toBeInstanceOf(RedisStore);
  });

  // -------------------------------------------------------------------------
  // 1. Identical deliveries, including truly concurrent ones
  // -------------------------------------------------------------------------
  it('10 concurrent identical deliveries across 5 gateway replicas → exactly one durable row and exactly one job of each type', async () => {
    const keys = createKeys(`p4-conc-${randomBytes(3).toString('hex')}`);
    const replicas = await Promise.all(
      Array.from({ length: 5 }, async () => ({ repo: replicaRepo(3), ...(await newQueue(keys)) })),
    );
    const d = delivery('evt_concurrent');
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const r = replicas[i % replicas.length];
        return ingestWebhook({ store: r.repo, enqueue: (t, p) => r.queue.enqueue(t, p) }, d);
      }),
    );
    const kinds = outcomes.map((o) => o.kind);
    expect(kinds.filter((k) => k === 'accepted')).toHaveLength(1);
    // Every other delivery is a duplicate (already enqueued → 200) or in
    // flight (the winner was still enqueueing → 503, provider retries). None
    // of them enqueued anything.
    expect(kinds.every((k) => k === 'accepted' || k === 'duplicate' || k === 'in_flight')).toBe(true);

    const [{ n }] = await client`SELECT count(*)::int AS n FROM webhook_events WHERE provider_id = 'stripe' AND provider_event_id = 'evt_concurrent'`;
    expect(n).toBe(1);
    const row = (await repo.findByProviderEvent('stripe', 'evt_concurrent'))!;
    expect(row.enqueuedAt).not.toBeNull();
    const { queue, store } = replicas[0];
    expect(await jobsFor(queue, store, keys, 'payment_webhook', row.id)).toHaveLength(1);
    expect(await jobsFor(queue, store, keys, 'provider_webhook', row.id)).toHaveLength(1);
    expect(await jobsFor(queue, store, keys, 'inbound_message', row.id)).toHaveLength(1);
    if (redis) {
      // All five replicas' queues are one shared Redis queue (B1 fixed).
      expect(await replicas[4].queue.readyCount('payment_webhook')).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Gateway restart — a separate OS process, sharing only Postgres
  // -------------------------------------------------------------------------
  it('a redelivery to a RESTARTED gateway (separate OS process, fresh pool, empty memory) is still recognised as a duplicate', async () => {
    const keys = createKeys(`p4-restart-${randomBytes(3).toString('hex')}`);
    const gatewayA = { repo: replicaRepo(2), ...(await newQueue(keys)) };
    const first = await ingestWebhook({ store: gatewayA.repo, enqueue: (t, p) => gatewayA.queue.enqueue(t, p) }, delivery('evt_restart'));
    expect(first.kind).toBe('accepted');
    // "Crash" gateway A: drop its pool and its queue connection entirely.
    await pools[pools.length - 1].end({ timeout: 5 });
    await gatewayA.store.quit?.();

    const { stdout } = await run(
      path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
      [
        'packages/database/src/test-fixtures/webhook-redeliver.ts',
        dbUrl,
        JSON.stringify([delivery('evt_restart'), delivery('evt_restart_new')]),
      ],
      { cwd: REPO_ROOT, timeout: 60_000 },
    );
    const result = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(result.pid).not.toBe(process.pid);
    expect(result.outcomes).toEqual([
      { providerEventId: 'evt_restart', kind: 'duplicate', webhookEventId: (first as { event: { id: string } }).event.id },
      expect.objectContaining({ providerEventId: 'evt_restart_new', kind: 'accepted' }),
    ]);
    // The restarted gateway enqueued ONLY the new event's jobs.
    expect(result.enqueued.map((e: { type: string }) => e.type).sort()).toEqual(['inbound_message', 'payment_webhook', 'provider_webhook']);
    expect(new Set(result.enqueued.map((e: { webhookEventId: string }) => e.webhookEventId))).toEqual(
      new Set([result.outcomes[1].webhookEventId]),
    );
    const [{ n }] = await client`SELECT count(*)::int AS n FROM webhook_events WHERE provider_event_id = 'evt_restart'`;
    expect(n).toBe(1);
  }, 90_000);

  // -------------------------------------------------------------------------
  // 3. Redis + worker: transient failure resumes from the durable table
  // -------------------------------------------------------------------------
  it('worker on a separate store connection processes gateway-enqueued jobs; a transient DB failure is retried to completion (no stuck replay marker)', async () => {
    const keys = createKeys(`p4-worker-${randomBytes(3).toString('hex')}`);
    const gateway = await newQueue(keys);
    const outcome = await ingestWebhook({ store: repo, enqueue: (t, p) => gateway.queue.enqueue(t, p) }, delivery('evt_transient'));
    expect(outcome.kind).toBe('accepted');
    const eventId = (outcome as Extract<WebhookIngestOutcome, { kind: 'accepted' }>).event.id;

    // Transient failure: the payment consumer's first durable write fails
    // (as a neon blip would); every later call goes to the real Postgres.
    let failuresLeft = 1;
    const flaky: WebhookEventRepository = {
      ...repo,
      persistEffectsOnce: async (args) => {
        if (args.idempotencyKey.endsWith(':payment_webhook') && failuresLeft-- > 0) {
          throw new Error('simulated transient DB failure');
        }
        return repo.persistEffectsOnce(args);
      },
    };
    const worker = await startWorker(keys, flaky);
    if (redis) {
      // Separate connection from the gateway's, yet it sees the gateway's jobs.
      expect(worker.store).toBeInstanceOf(RedisStore);
      expect(worker.store).not.toBe(gateway.store);
    }

    await waitFor(async () => (await repo.findById(eventId))?.status === 'processed', 'event processed');
    const consumers = await repo.findConsumers(eventId);
    expect(consumers.map((c) => [c.consumer, c.status, c.attempts])).toEqual([
      ['payment_webhook', 'processed', 2], // failed once, re-claimed cleanly, processed
      ['provider_webhook', 'processed', 1],
    ]);
    const effects = await client`
      SELECT idempotency_key, count(*)::int AS n FROM events
      WHERE idempotency_key LIKE ${`webhook:${eventId}:%`} GROUP BY 1 ORDER BY 1`;
    expect(effects.map((r) => [r.idempotency_key, r.n])).toEqual([
      [`webhook:${eventId}:payment_webhook`, 1],
      [`webhook:${eventId}:provider_webhook`, 1],
    ]);
    const [{ ob }] = await client`SELECT count(*)::int AS ob FROM outbox_events WHERE payload->>'id' = 'evt_transient'`;
    expect(ob).toBe(1);

    // A replayed job for the processed event is a no-op that COMPLETES.
    const replay = await worker.manager.getQueue().enqueue('payment_webhook', {
      provider: 'stripe',
      providerEventId: 'evt_transient',
      rawBody: delivery('evt_transient').rawBody,
      signature: delivery('evt_transient').signature,
      webhookEventId: eventId,
    });
    await waitFor(async () => (await worker.manager.getQueue().getJob(replay.id))?.status === 'completed', 'replay completed');
    const [{ n }] = await client`SELECT count(*)::int AS n FROM events WHERE idempotency_key = ${`webhook:${eventId}:payment_webhook`}`;
    expect(n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Out-of-order delivery and never-seen events
  // -------------------------------------------------------------------------
  it('out-of-order deliveries: every first sighting is accepted, every redelivery (any order) is a duplicate, a never-seen event is accepted; each processed exactly once', async () => {
    const keys = createKeys(`p4-order-${randomBytes(3).toString('hex')}`);
    const gateway = await newQueue(keys);
    const ingest = (d: WebhookIngestInput) => ingestWebhook({ store: repo, enqueue: (t, p) => gateway.queue.enqueue(t, p) }, d);

    // The refund notification overtakes the charge notification.
    const refunded = delivery('evt_ooo_2_refunded', 'charge.refunded');
    const succeeded = delivery('evt_ooo_1_succeeded', 'charge.succeeded');
    expect((await ingest(refunded)).kind).toBe('accepted');
    expect((await ingest(succeeded)).kind).toBe('accepted');
    for (const d of [succeeded, refunded, succeeded, refunded]) {
      expect((await ingest(d)).kind).toBe('duplicate');
    }
    const fresh = delivery('evt_ooo_3_never_seen', 'charge.succeeded');
    expect((await ingest(fresh)).kind).toBe('accepted');
    // Same event id from another provider is a different durable identity.
    expect((await ingest(delivery('evt_ooo_1_succeeded', 'charge.succeeded', 'paystack'))).kind).toBe('accepted');

    expect(await gateway.queue.readyCount('payment_webhook')).toBe(4);

    await startWorker(keys, repo);
    const ids = ['evt_ooo_2_refunded', 'evt_ooo_1_succeeded', 'evt_ooo_3_never_seen'];
    await waitFor(async () => {
      const rows = await client`SELECT status FROM webhook_events WHERE provider_event_id = ANY(${ids}) AND provider_id = 'stripe'`;
      return rows.length === 3 && rows.every((r) => r.status === 'processed');
    }, 'three stripe events processed');
    const perEvent = await client`
      SELECT we.provider_event_id, count(e.id)::int AS n
      FROM webhook_events we JOIN events e ON e.idempotency_key = 'webhook:' || we.id || ':payment_webhook'
      WHERE we.provider_id = 'stripe' AND we.provider_event_id = ANY(${ids})
      GROUP BY 1 ORDER BY 1`;
    expect(perEvent.map((r) => [r.provider_event_id, r.n])).toEqual([
      ['evt_ooo_1_succeeded', 1],
      ['evt_ooo_2_refunded', 1],
      ['evt_ooo_3_never_seen', 1],
    ]);
  });

  // -------------------------------------------------------------------------
  // 5. Failures before acknowledgement are never acknowledged — and recover
  // -------------------------------------------------------------------------
  it('enqueue failure (e.g. Redis down / backpressure) → not acknowledged, durable row kept; the provider retry recovers it exactly once', async () => {
    const keys = createKeys(`p4-enq-${randomBytes(3).toString('hex')}`);
    const gateway = await newQueue(keys);
    const d = delivery('evt_enqueue_fail');
    const failing = await ingestWebhook(
      {
        store: repo,
        enqueue: async (type) => {
          throw new QueueBackpressureError(type, 10_000, 10_000);
        },
      },
      d,
    );
    expect(failing.kind).toBe('enqueue_failed'); // gateway answers 503
    const row = (await repo.findByProviderEvent('stripe', 'evt_enqueue_fail'))!;
    expect(row.enqueuedAt).toBeNull();
    expect(row.enqueueLeaseUntil).toBeNull(); // released at once for the retry

    const retry = await ingestWebhook({ store: repo, enqueue: (t, p) => gateway.queue.enqueue(t, p) }, d);
    expect(retry.kind).toBe('recovered'); // gateway answers 200
    const again = await ingestWebhook({ store: repo, enqueue: (t, p) => gateway.queue.enqueue(t, p) }, d);
    expect(again.kind).toBe('duplicate');
    expect(await jobsFor(gateway.queue, gateway.store, keys, 'payment_webhook', row.id)).toHaveLength(1);
  });

  it('a gateway that crashed between persist and enqueue is recovered by the worker sweeper, exactly once', async () => {
    const keys = createKeys(`p4-sweep-${randomBytes(3).toString('hex')}`);
    const workerSide = await newQueue(keys);
    // Persisted, then the process died: no enqueue, lease left to lapse.
    const claim = await repo.claim({ ...delivery('evt_crashed_gateway'), expectedConsumers: ['payment_webhook', 'provider_webhook'], enqueueLeaseMs: 0 });
    expect(claim.claimed).toBe(true);
    const enqueue = (t: Parameters<JobQueue['enqueue']>[0], p: Parameters<JobQueue['enqueue']>[1]) => workerSide.queue.enqueue(t, p);
    await recoverStrandedWebhookEvents(repo, enqueue);
    await recoverStrandedWebhookEvents(repo, enqueue); // second sweep finds nothing
    const row = (await repo.findByProviderEvent('stripe', 'evt_crashed_gateway'))!;
    expect(row.enqueuedAt).not.toBeNull();
    expect(await jobsFor(workerSide.queue, workerSide.store, keys, 'payment_webhook', row.id)).toHaveLength(1);
  });

  it('a durable-persist failure (DB unreachable) is never acknowledged and enqueues nothing', async () => {
    const dead = postgres('postgres://postgres@127.0.0.1:1/none', { max: 1, connect_timeout: 2, onnotice: () => {} });
    pools.push(dead);
    const deadRepo = createWebhookEventRepository(() => drizzle(dead) as never);
    let enqueued = 0;
    const outcome = await ingestWebhook(
      { store: deadRepo, enqueue: async () => { enqueued++; } },
      delivery('evt_db_down'),
    );
    expect(outcome.kind).toBe('persist_failed'); // gateway answers 503
    expect(enqueued).toBe(0);
  });
});
