import { describe, it, expect, vi, beforeEach } from 'vitest';

const { eventRepository, auditLogRepository, transactionRepository } = vi.hoisted(() => ({
  eventRepository: { countByCategory: vi.fn().mockResolvedValue({}) },
  auditLogRepository: { create: vi.fn().mockResolvedValue(undefined) },
  transactionRepository: { findStaleUnresolved: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@company/database', () => ({ eventRepository, auditLogRepository, transactionRepository }));

import { createReconciliationProcessor } from './reconciliation';
import { JobDeps } from './deps';
import { Job, WorkerContext } from '../types';
import { JobQueue } from '../queue';

function makeJob(): Job {
  return {
    id: 'job1',
    type: 'reconciliation',
    payload: {},
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
    lock: { withLock: (_resource: string, _owner: string, _ttl: number, fn: () => Promise<unknown>) => fn() },
    config: { retry: { maxDelayMs: 300_000 } },
    eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
    registry: {},
    routing: {},
    rateLimiter: {},
    keys: {},
  } as unknown as JobDeps;
}

function makeQueue(): JobQueue {
  return { deadCount: vi.fn().mockResolvedValue(0) } as unknown as JobQueue;
}

const ctx = {} as unknown as WorkerContext;

describe('createReconciliationProcessor — real payment reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogRepository.create.mockResolvedValue(undefined);
    eventRepository.countByCategory.mockResolvedValue({});
  });

  it('includes an empty stale-transaction report when nothing is stuck', async () => {
    transactionRepository.findStaleUnresolved.mockResolvedValue([]);
    const deps = makeDeps();
    const processor = createReconciliationProcessor(deps, makeQueue());

    await processor(makeJob(), ctx);

    expect(transactionRepository.findStaleUnresolved).toHaveBeenCalledTimes(1);
    const [auditCall] = auditLogRepository.create.mock.calls[0];
    const report = JSON.parse(auditCall.details);
    expect(report.payments.staleCount).toBe(0);
    expect(report.payments.stale).toEqual([]);
  });

  it('reports stale transactions by id/provider/amount without guessing an outcome', async () => {
    const stuck = {
      id: 'tx_1',
      appId: 'reach-church',
      providerId: 'flutterwave',
      providerTransactionId: 'flw-tx-abc',
      status: 'pending',
      amount: '25.00',
      currency: 'NGN',
      updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
    };
    transactionRepository.findStaleUnresolved.mockResolvedValue([stuck]);
    const deps = makeDeps();
    const processor = createReconciliationProcessor(deps, makeQueue());

    await processor(makeJob(), ctx);

    const [auditCall] = auditLogRepository.create.mock.calls[0];
    const report = JSON.parse(auditCall.details);
    expect(report.payments.staleCount).toBe(1);
    expect(report.payments.stale[0]).toMatchObject({
      id: 'tx_1',
      providerId: 'flutterwave',
      providerTransactionId: 'flw-tx-abc',
      status: 'pending',
      amount: '25.00',
    });
    // No field claims a resolved outcome (success/failed) — this is
    // detection only.
    expect(report.payments.stale[0].resolvedStatus).toBeUndefined();
  });

  it('does not fail the job when transactionRepository errors — degrades to an empty report', async () => {
    transactionRepository.findStaleUnresolved.mockRejectedValue(new Error('db down'));
    const deps = makeDeps();
    const processor = createReconciliationProcessor(deps, makeQueue());

    await expect(processor(makeJob(), ctx)).resolves.toBeUndefined();
    const [auditCall] = auditLogRepository.create.mock.calls[0];
    const report = JSON.parse(auditCall.details);
    expect(report.payments.staleCount).toBe(0);
  });
});
