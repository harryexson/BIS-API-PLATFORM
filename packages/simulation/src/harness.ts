import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@company/events';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import {
  MemoryStore,
  createKeys,
  DistributedLock,
  RateLimiter,
  WorkerManager,
  registerAllProcessors,
  type JobQueue,
  type Job,
  type Keys,
  type KVStore,
  type WorkerConfig,
} from '@company/workers';
import { dbState, API_KEY, TENANT_ID, type ConversationRow } from './db';

// ---------------------------------------------------------------------------
// Simulation harness.
//
// Boots the REAL Express API Gateway over an ephemeral HTTP port and the REAL
// worker stack (MemoryStore queue + registered processors) inside the same
// process, so the ProviderRegistry / EventBus singletons are shared between
// the gateway and the worker exactly like production.
//
// The only simulated piece is the persistent store: '@company/database' is
// replaced with the in-memory double from ./db (it supports live fault
// injection). Provider adapters (Stripe, ...) are the real simulated adapters.
// ---------------------------------------------------------------------------

export const WEBHOOK_SECRET = 'sim-webhook-hmac-secret-0123456789abcdef';

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  redisUrl: 'memory',
  concurrency: 3,
  queuePrefix: 'bis-sim',
  idempotencyTtlMs: 60_000,
  pollIntervalMs: 10,
  reconciliationIntervalMs: 300_000,
  providerHealthIntervalMs: 300_000,
  retryProcessingIntervalMs: 300_000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 50,
    factor: 2,
    maxDeadRetries: 2,
  },
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10_000,
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs?: number; everyMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const everyMs = opts.everyMs ?? 25;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out: ${opts.label ?? 'condition'}`);
    }
    await sleep(everyMs);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface WorkerHandle {
  manager: WorkerManager;
  queue: JobQueue;
  store: KVStore;
  keys: Keys;
  config: WorkerConfig;
  lock: DistributedLock;
  rateLimiter: RateLimiter;
}

export interface SimRuntime {
  baseUrl: string;
  server: Server;
  bus: EventBus;
  registry: ProviderRegistry;
  // stop the booted HTTP server
  close(): Promise<void>;
  // spawn an isolated worker (own store/keys unless supplied) against the
  // shared routing/eventbus/registry
  makeWorker(opts?: { store?: KVStore; keys?: Keys; config?: Partial<WorkerConfig> }): Promise<WorkerHandle>;
  // raw HTTP helpers
  request(method: string, path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  postText(path: string, body: string, headers?: Record<string, string>): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
}

let bootedApp: unknown | null = null;

export async function createSimulation(
  opts: { env?: Record<string, string> } = {},
): Promise<SimRuntime> {
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    process.env[key] = value;
  }
  process.env.WEBHOOK_HMAC_SECRET = WEBHOOK_SECRET;
  if (!process.env.RATE_LIMIT_MAX_REQUESTS) process.env.RATE_LIMIT_MAX_REQUESTS = '100000';

  if (bootedApp === null) {
    const module = await import('../../../services/api-gateway/src/app');
    bootedApp = module.default;
  }
  const app = bootedApp as { listen: (port: number, cb: () => void) => Server };

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const bus = EventBus.getInstance();
  const registry = ProviderRegistry.getInstance();
  const routing = new RoutingEngine();

  async function close(): Promise<void> {
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async function makeWorker(opts: { store?: KVStore; keys?: Keys; config?: Partial<WorkerConfig> } = {}) {
    const config: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...(opts.config ?? {}) };
    const store = opts.store ?? new MemoryStore();
    const keys = opts.keys ?? createKeys(config.queuePrefix);
    const lock = new DistributedLock(store, keys);
    const rateLimiter = new RateLimiter(store, keys, config.rateLimit);
    const deps = {
      registry,
      routing,
      eventBus: bus,
      lock,
      rateLimiter,
      config,
      keys,
    };
    const manager = new WorkerManager(store, keys, config);
    registerAllProcessors(manager, deps, manager.getQueue());
    await manager.start();
    return { manager, queue: manager.getQueue(), store, keys, config, lock, rateLimiter };
  }

  async function request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method, ...init });
  }

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function postText(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  }

  return { baseUrl, server, bus, registry, close, makeWorker, request, post, postText, get };
}

// ---------------------------------------------------------------------------
// Flow primitives (mirror what Reach Church / the platform do)
// ---------------------------------------------------------------------------

export type StripeWebhookType = 'charge.succeeded' | 'charge.refunded';

export function buildStripeWebhook(chargeId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: (overrides.id as string) ?? `evt_${randomUUID().slice(0, 12)}`,
    object: 'event',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: '2024-06-20',
    type: (overrides.type ?? 'charge.succeeded') as StripeWebhookType,
    data: {
      object: {
        id: chargeId,
        object: 'charge',
        amount: 5000,
        amount_captured: 5000,
        currency: 'usd',
        status: 'succeeded',
        paid: true,
        receipt_email: 'donor@reach.example',
        billing_details: { email: 'donor@reach.example' },
        ...(overrides.data ?? {}),
      },
    },
  };
}

export function signWebhook(rawBody: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export interface DonationResult {
  txId: string;
  body: any;
  status: number;
}

export type DonationPayload = {
  amount?: number;
  currency?: string;
  paymentMethod?: string;
  providerOverride?: string;
  phoneNumber?: string;
  idempotencyKey?: string;
};

/**
 * Reach Church -> Create Donation -> API Gateway -> (auth/tenant plugins are
 * exercised by middleware inside the gateway) -> Payment Router -> Provider.
 */
export async function createDonation(
  runtime: SimRuntime,
  payload: DonationPayload = {},
  extraHeaders: Record<string, string> = {},
): Promise<DonationResult> {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer bap_test_reachchurch_0001`,
    'x-tenant-id': 'ten_reach_church',
    ...(payload.idempotencyKey ? { 'idempotency-key': payload.idempotencyKey } : {}),
    ...extraHeaders,
  };
  const res = await runtime.post('/v1/api/gateway/payment', {
    amount: payload.amount ?? 50,
    currency: payload.currency ?? 'USD',
    paymentMethod: payload.paymentMethod ?? 'card',
    providerOverride: payload.providerOverride ?? 'stripe',
    phoneNumber: payload.phoneNumber ?? '+15550001111',
  }, headers);
  const body = await res.json().catch(() => ({}));
  return { txId: body.id, body, status: res.status };
}

/**
 * Deliver a Stripe webhook: HMAC signing + the real gateway verification
 * endpoint. Returns verification response + the proof material so the harness
 * can hand the verified webhook to the worker.
 */
export async function deliverWebhook(
  runtime: SimRuntime,
  provider: string,
  body: unknown,
): Promise<{ status: number; json: any; rawBody: string; signature: string }> {
  const rawBody = JSON.stringify(body);
  const signature = signWebhook(rawBody);
  const res = await runtime.postText(`/v1/api/webhooks/${provider}`, rawBody, {
    'x-webhook-signature': signature,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, rawBody, signature };
}

/**
 * Wire the envelope that the gateway currently does NOT send: hand the
 * verified webhook to the worker so it can be parsed, idempotency-checked,
 * recorded ("Transaction Update") and emitted ("Event Processing").
 */
export function enqueuePaymentWebhook(
  queue: JobQueue,
  input: { appId: string; providerId: string; rawBody: string; signature: string; id: string },
): Promise<Job> {
  // Parse the rawBody to include the full webhook payload in the job
  let webhookPayload: Record<string, unknown> = {};
  try {
    webhookPayload = JSON.parse(input.rawBody);
  } catch {
    // ignore parse errors
  }
  // Merge webhook body fields with the flat input, keeping input fields take precedence
  return queue.enqueue('payment_webhook', {
    ...webhookPayload,
    ...input,
    provider: input.providerId,
    applicationId: input.appId,
    providerEventId: input.id,
  });
}

export function enqueueEventProcessing(queue: JobQueue, event: any): Promise<Job> {
  return queue.enqueue('event_processing', { ...event });
}

export function enqueueReceipt(
  queue: JobQueue,
  input: { appId: string; recipient: string; content: string; providerOverride?: string },
): Promise<Job> {
  return queue.enqueue('message_delivery', input, {
    idempotencyKey: `receipt:${input.appId}:${input.recipient}:${input.content}`,
  });
}

// ---------------------------------------------------------------------------
// Messaging flow primitives
// ---------------------------------------------------------------------------

export interface MessageResult {
  status: number;
  body: any;
}

/**
 * Reach Church -> POST /messages -> API Gateway -> Tenant Resolution ->
 * Messaging Router -> Provider Selection -> Delivery Event. Mirrors the app's
 * outbound send; the gateway routes via the REAL RoutingEngine and returns the
 * resulting TransactionEvent.
 */
export async function sendMessage(
  runtime: SimRuntime,
  payload: { recipient: string; content: string; providerOverride?: string },
  extraHeaders: Record<string, string> = {},
): Promise<MessageResult> {
  const res = await runtime.post(
    '/v1/api/gateway/messaging',
    {
      recipient: payload.recipient,
      content: payload.content,
      providerOverride: payload.providerOverride,
    },
    {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      'x-tenant-id': TENANT_ID,
      ...extraHeaders,
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Inbound mobile-originated message as delivered by a messaging provider to
 * the platform webhook endpoint (the "Platform Webhook" step).
 */
export function buildInboundSms(overrides: Record<string, unknown> = {}) {
  return {
    id: `inb_${randomUUID().slice(0, 12)}`,
    from: '+15550001111',
    to: '39900',
    text: 'YES',
    timestamp: new Date().toISOString(),
    messageType: 'sms',
    provider: 'signalhouse',
    ...overrides,
  };
}

/**
 * Bridge the inbound webhook envelope to the real provider_webhook worker job
 * (the same production gap as payment webhooks — the gateway verifies but does
 * not enqueue). The worker re-verifies the HMAC, dedupes by id, and records
 * the "Delivery Event".
 */
export function enqueueProviderWebhook(
  queue: JobQueue,
  input: { providerId: string; rawBody: string; signature: string; id: string; status?: string },
): Promise<Job> {
  return queue.enqueue('provider_webhook', input);
}

/** Active/closed conversation the platform tracked for (appId, phoneNumber, tenantId?). */
export function findConversation(
  appId: string,
  phoneNumber: string,
  tenantId?: string,
): ConversationRow | undefined {
  return dbState.conversations.find(
    (c) =>
      c.appId === appId &&
      c.phoneNumber === phoneNumber &&
      (tenantId ? c.tenantId === tenantId : true),
  );
}

/**
 * Subscribe the "Giving Receipt" step: whenever a charge.succeeded webhook is
 * processed, a receipt message is queued to the donor.
 *
 * P0 FIX: Check both `eventType` (normalized schema) and `type` (raw Stripe body)
 * since the paymentWebhook processor now normalizes `type` → `eventType`.
 */
export function wireReceiptPipeline(handle: WorkerHandle, runtime: SimRuntime): () => void {
  return runtime.bus.subscribe((event: any) => {
    const webhookType = event.payload?.eventType ?? event.payload?.type;
    if (
      event.decisionReason === 'payment_webhook_received' &&
      webhookType === 'charge.succeeded'
    ) {
      const recipient = event.payload?.data?.object?.receipt_email ?? 'donor@reach.example';
      const chargeId = event.payload?.data?.object?.id ?? randomUUID();
      const p = enqueueReceipt(handle.queue, {
        appId: event.appId,
        recipient,
        content: `Reach Church giving receipt for your gift of $${Math.round((event.payload?.data?.object?.amount ?? 0) / 100)}.00 (charge:${chargeId})`,
      }).then(() => {}).catch((err) => console.error('[sim] receipt enqueue failed', err));
      pendingBusEffects.push(p);
      p.finally(() => {
        const idx = pendingBusEffects.indexOf(p);
        if (idx >= 0) pendingBusEffects.splice(idx, 1);
      });
    }
  });
}

export interface QueueCounts {
  ready: number;
  delayed: number;
  dead: number;
}

// Track fire-and-forget promises from EventBus listeners so drain can wait for them.
const pendingBusEffects: Array<Promise<void>> = [];

export function counts(handle: WorkerHandle, type: string): Promise<QueueCounts> {
  const jobType = type as import('@company/workers').JobType;
  return Promise.all([
    handle.queue.readyCount(jobType),
    handle.queue.delayedCount(jobType),
    handle.queue.deadCount(jobType),
  ]).then(([ready, delayed, dead]) => ({ ready, delayed, dead }));
}

export async function drain(
  handle: WorkerHandle,
  types: string[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  // First: wait for any fire-and-forget EventBus side-effects to resolve
  // (e.g. wireReceiptPipeline enqueueing a message_delivery job).
  if (pendingBusEffects.length > 0) {
    await waitFor(async () => pendingBusEffects.length === 0, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      everyMs: 5,
      label: 'drain pending bus effects',
    });
  }

  await waitFor(async () => {
    for (const type of types) {
      const c = await counts(handle, type);
      if (c.ready > 0 || c.delayed > 0) return false;
    }
    return true;
  }, { timeoutMs: opts.timeoutMs ?? 15_000, everyMs: 25, label: `drain ${types.join(',')}` });

  // Wait for in-flight jobs to complete so bus events are flushed.
  await waitFor(async () => handle.manager.getInFlight() === 0, {
    timeoutMs: opts.timeoutMs ?? 15_000,
    everyMs: 5,
    label: 'drain in-flight',
  });

  // settle: let any final emits / microtasks flush
  await sleep(60);
}

export async function stopWorker(handle: WorkerHandle): Promise<void> {
  await handle.manager.stop();
}

/**
 * A KVStore whose every operation throws — used to simulate "Redis / backing
 * store unavailable". Passing this to makeWorker({ store }) makes the worker's
 * poll loop die on the first store op (no graceful degradation).
 */
export function createFailingStore(): KVStore {
  const fail = (): never => {
    throw new Error('Redis unavailable (simulated)');
  };
  // Every property access returns an async function that rejects, so both
  // awaited methods and sync-style property reads blow up like a dead store.
  return new Proxy({} as KVStore, {
    get: () => async () => {
      throw new Error('Redis unavailable (simulated)');
    },
  }) as unknown as KVStore;
}