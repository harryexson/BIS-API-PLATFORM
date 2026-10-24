import {
  ReadinessGate,
  probeQueueStore,
  probeDatabase,
  probeEventBus,
  probeProviderState,
  probeSecrets,
  missingSecrets,
  readinessUp,
  readinessFailed,
  type EventBusRedisStatus,
  type KVStore,
  type ProbeResult,
} from '@company/workers';

/**
 * Phase 19 (gap register B13): the worker's /ready used to be
 * `manager.isRunning()` and nothing else — a worker whose queue had fallen
 * back to a private MemoryStore (so it polls a queue no gateway enqueues
 * into), with no database, or with no WEBHOOK_HMAC_SECRET (so every payment
 * webhook job is rejected and dead-lettered) still answered "ready".
 */

/**
 * WEBHOOK_HMAC_SECRET: payment_webhook/provider_webhook fail closed without
 * it. SECRET_ENCRYPTION_KEY: persisted provider secrets cannot be decrypted.
 */
export const WORKER_REQUIRED_SECRETS = ['WEBHOOK_HMAC_SECRET', 'SECRET_ENCRYPTION_KEY'] as const;

export interface WorkerReadinessDeps {
  manager: { isRunning(): boolean };
  store: KVStore;
  redisUrl: string | undefined;
  providerState: () => { loaded: boolean; secretFailures: unknown[] };
  eventBus: { getRedisStatus(): EventBusRedisStatus };
  checkDatabase: () => Promise<{ status: string }>;
  gate?: ReadinessGate;
}

export interface WorkerReadinessResult {
  httpStatus: 200 | 503;
  body: {
    status: 'ready' | 'not-ready';
    service: 'worker';
    running: boolean;
    dependencies: Record<string, string>;
    failing: string[];
    degraded: string[];
    missingSecrets?: string[];
    timestamp: string;
  };
}

export function createWorkerReadiness(deps: WorkerReadinessDeps): () => Promise<WorkerReadinessResult> {
  const gate = deps.gate ?? new ReadinessGate();
  return async () => {
    const production = process.env.NODE_ENV === 'production';
    const running = deps.manager.isRunning();
    const missing = missingSecrets(WORKER_REQUIRED_SECRETS);
    const probes: Record<string, ProbeResult> = {
      running: running ? readinessUp('running') : readinessFailed('stopped'),
      queue: probeQueueStore(deps.store, deps.redisUrl, production),
      database: await probeDatabase(deps.checkDatabase),
      providers: probeProviderState(deps.providerState()),
      eventBus: probeEventBus(deps.eventBus.getRedisStatus()),
      secrets: probeSecrets(missing, production),
    };
    const report = gate.evaluate(probes);
    return {
      httpStatus: report.ready ? 200 : 503,
      body: {
        status: report.ready ? 'ready' : 'not-ready',
        service: 'worker',
        running,
        dependencies: report.dependencies,
        failing: report.failing,
        degraded: report.degraded,
        ...(missing.length > 0 ? { missingSecrets: missing } : {}),
        timestamp: new Date().toISOString(),
      },
    };
  };
}
