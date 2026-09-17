import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const { eventRepository } = vi.hoisted(() => ({
  eventRepository: { create: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@company/database', () => ({ eventRepository }));

import { createProviderWebhookProcessor } from './providerWebhook';
import { JobDeps } from './deps';
import { Job, WorkerContext } from '../types';

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: 'job1',
    type: 'provider_webhook',
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
    keys: {},
    config: { retry: { maxDelayMs: 300_000 } },
    eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    registry: { updateManagement: vi.fn() },
    routing: {},
    lock: { withLock: vi.fn((_key: string, _owner: string, _ttl: number, fn: () => Promise<void>) => fn()) },
    rateLimiter: {},
  } as unknown as JobDeps;
}

const ctx = { signal: new AbortController().signal } as unknown as WorkerContext;

describe('createProviderWebhookProcessor — verificationMethod trust boundary', () => {
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
    const processor = createProviderWebhookProcessor(deps);

    const job = makeJob({
      providerId: 'stripe',
      rawBody: '{"type":"charge.succeeded"}',
      verificationMethod: 'native',
      id: 'evt_1',
    });

    await expect(processor(job, ctx)).resolves.toBeUndefined();
    expect(eventRepository.create).toHaveBeenCalledTimes(1);
  });

  it('still fails closed for a platform-verified webhook with a bad signature', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'platform-secret';
    const deps = makeDeps();
    const processor = createProviderWebhookProcessor(deps);

    const job = makeJob({
      providerId: 'genericprovider',
      rawBody: '{"type":"charge.succeeded"}',
      verificationMethod: 'platform',
      signature: 'deadbeef00',
      id: 'evt_2',
    });

    await expect(processor(job, ctx)).rejects.toThrow('provider_webhook signature verification failed');
    expect(eventRepository.create).not.toHaveBeenCalled();
  });

  it('processes a platform-verified webhook whose signature actually matches', async () => {
    process.env.WEBHOOK_HMAC_SECRET = 'platform-secret';
    const deps = makeDeps();
    const processor = createProviderWebhookProcessor(deps);

    const rawBody = '{"type":"charge.succeeded"}';
    const signature = createHmac('sha256', 'platform-secret').update(rawBody).digest('hex');

    const job = makeJob({
      providerId: 'genericprovider',
      rawBody,
      verificationMethod: 'platform',
      signature,
      id: 'evt_3',
    });

    await expect(processor(job, ctx)).resolves.toBeUndefined();
    expect(eventRepository.create).toHaveBeenCalledTimes(1);
  });
});
