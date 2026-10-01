import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const { eventRepository, outboxEventRepository, transactionRepository, runInTransaction } = vi.hoisted(() => ({
  eventRepository: { create: vi.fn().mockResolvedValue(undefined) },
  outboxEventRepository: { create: vi.fn().mockResolvedValue(undefined) },
  transactionRepository: { findByProviderTransactionId: vi.fn().mockResolvedValue(null), updateStatus: vi.fn() },
  runInTransaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({})),
}));

vi.mock('@company/database', () => ({
  eventRepository,
  outboxEventRepository,
  transactionRepository,
  runInTransaction,
}));

import { createPaymentWebhookProcessor } from './paymentWebhook';
import { JobDeps } from './deps';
import { Job, WorkerContext } from '../types';

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: 'job1',
    type: 'payment_webhook',
    payload,
    attempts: 0,
    maxAttempts: 3,
    status: 'processing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runAt: Date.now(),
  };
}

function makeDeps(): JobDeps {
  return {
    keys: { idempotency: (s: string) => `idem:${s}` },
    config: { idempotencyTtlMs: 60_000 },
    eventBus: { emit: vi.fn() },
    registry: {},
    routing: {},
    lock: {},
    rateLimiter: {},
  } as unknown as JobDeps;
}

// No ctx.store — the idempotency-replay check is skipped when it's absent,
// which is all this suite needs; it's testing the signature-verification
// branch, not the dedup path (covered separately at the gateway level).
const ctx = { signal: new AbortController().signal } as unknown as WorkerContext;

describe('createPaymentWebhookProcessor — verificationMethod trust boundary', () => {
  const originalSecret = process.env.WEBHOOK_HMAC_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.WEBHOOK_HMAC_SECRET;
    else process.env.WEBHOOK_HMAC_SECRET = originalSecret;
  });

  it('processes a native-verified webhook with no generic signature at all, without re-checking it', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'platform-secret';
    const deps = makeDeps();
    const processor = createPaymentWebhookProcessor(deps);

    const job = makeJob({
      provider: 'stripe',
      rawBody: '{"type":"charge.succeeded"}',
      verificationMethod: 'native',
      // Deliberately no `signature` field — a real Stripe webhook has no
      // generic x-webhook-signature to carry here.
      providerEventId: 'evt_1',
    });

    await expect(processor(job, ctx)).resolves.toBeUndefined();
    expect(eventRepository.create).toHaveBeenCalledTimes(1);
    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1);
  });

  it('still fails closed for a platform-verified webhook with a bad signature', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'platform-secret';
    const deps = makeDeps();
    const processor = createPaymentWebhookProcessor(deps);

    const job = makeJob({
      provider: 'genericprovider',
      rawBody: '{"type":"charge.succeeded"}',
      verificationMethod: 'platform',
      signature: 'deadbeef00',
      providerEventId: 'evt_2',
    });

    await expect(processor(job, ctx)).rejects.toThrow('payment_webhook signature verification failed');
    expect(eventRepository.create).not.toHaveBeenCalled();
  });

  it('processes a platform-verified webhook whose signature actually matches', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'platform-secret';
    const deps = makeDeps();
    const processor = createPaymentWebhookProcessor(deps);

    const rawBody = '{"type":"charge.succeeded"}';
    const signature = createHmac('sha256', 'platform-secret').update(rawBody).digest('hex');

    const job = makeJob({
      provider: 'genericprovider',
      rawBody,
      verificationMethod: 'platform',
      signature,
      providerEventId: 'evt_3',
    });

    await expect(processor(job, ctx)).resolves.toBeUndefined();
    expect(eventRepository.create).toHaveBeenCalledTimes(1);
  });

  it('treats a job with no verificationMethod (legacy/back-compat) as platform and requires a valid signature', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'platform-secret';
    const deps = makeDeps();
    const processor = createPaymentWebhookProcessor(deps);

    const job = makeJob({
      provider: 'genericprovider',
      rawBody: '{"type":"charge.succeeded"}',
      providerEventId: 'evt_4',
      // No verificationMethod, no signature.
    });

    await expect(processor(job, ctx)).rejects.toThrow('payment_webhook signature required');
  });
});
