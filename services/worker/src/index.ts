import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { createServer } from 'node:http';
import { ProviderRegistry, ProviderStateSync } from '@company/providers';
import { providerStateStore, checkDatabaseHealth } from '@company/database';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';
import {
  createStore,
  createKeys,
  createWorkerConfig,
  WorkerManager,
  DistributedLock,
  RateLimiter,
  registerAllProcessors,
} from '@company/workers';
import { logger } from '@company/observability';
import { createWorkerReadiness } from './readiness';

async function main(): Promise<void> {
  const config = createWorkerConfig();
  const store = await createStore(config.redisUrl);
  const keys = createKeys(config.queuePrefix);

  const manager = new WorkerManager(store, keys, config);
  const queue = manager.getQueue();

  const registry = ProviderRegistry.getInstance();
  const routing = new RoutingEngine();

  // Phase 15 (gap register E12): the worker dispatches provider calls too,
  // so it must route by the same persisted configuration and secrets as the
  // gateway — previously it never loaded either (not even the secrets the
  // gateway hydrated) and ran on code defaults + env vars. Loaded before
  // any job is processed, then kept converged on admin changes.
  const providerStateSync = new ProviderStateSync(registry, providerStateStore, {
    intervalMs: Number(process.env.PROVIDER_STATE_REFRESH_MS) || 5_000,
    onReport(report) {
      // Same shape as the gateway's provider-state logging (app.ts).
      for (const f of report.secretFailures) {
        logger.error('persisted provider secrets could not be decrypted — provider withheld from routing', {
          operation: 'provider_state_sync',
          providerId: f.slug,
          errorCode: 'PROVIDER_SECRETS_DECRYPT_FAILED',
          status: 'failed',
          error: f.error,
        });
      }
    },
    onError(err) {
      logger.error('provider state load failed', {
        operation: 'provider_state_sync',
        errorCode: 'PROVIDER_STATE_LOAD_FAILED',
        status: 'failed',
        error: err,
      });
    },
  });
  await providerStateSync.initialLoad;
  if (!providerStateSync.status().loaded && process.env.NODE_ENV === 'production') {
    throw new Error(`persisted provider state could not be loaded: ${providerStateSync.status().lastError}`);
  }
  providerStateSync.start();
  const eventBus = EventBus.getInstance();

  const lock = new DistributedLock(store, keys);
  const rateLimiter = new RateLimiter(store, keys, config.rateLimit);

  registerAllProcessors(
    manager,
    { registry, routing, eventBus, lock, rateLimiter, config, keys },
    queue,
  );

  // P1: Rescue stuck processing jobs from previous crashes before starting
  const rescued = await queue.rescueStuckJobs();
  if (rescued > 0) {
    logger.info('rescued stuck processing jobs', { operation: 'reaper', status: 'rescued', rescued });
  }

  const logEnqueueFailure = (jobType: string) => (err: unknown) =>
    logger.error('scheduled job enqueue failed', {
      operation: 'scheduler',
      jobType,
      errorCode: 'SCHEDULED_ENQUEUE_FAILED',
      status: 'failed',
      error: err,
    });

  await manager.start();

  const providers = registry.getAllConfigs().map((c) => c.id);

  const enqueueProviderHealth = () => {
    for (const id of providers) {
      queue.enqueue('provider_health', { providerId: id }).catch(logEnqueueFailure('provider_health'));
    }
  };

  enqueueProviderHealth();
  const healthTimer = setInterval(enqueueProviderHealth, config.providerHealthIntervalMs);

  queue
    .enqueue('retry_processing', {})
    .catch(logEnqueueFailure('retry_processing'));
  const retryTimer = setInterval(
    () => queue.enqueue('retry_processing', {}).catch(() => undefined),
    config.retryProcessingIntervalMs,
  );

  queue
    .enqueue('reconciliation', {})
    .catch(logEnqueueFailure('reconciliation'));
  const reconTimer = setInterval(
    () => queue.enqueue('reconciliation', {}).catch(() => undefined),
    config.reconciliationIntervalMs,
  );

  // outbox_poller and webhook_job_poller were registered as processors but
  // never actually scheduled — they'd sit idle forever without this.
  queue
    .enqueue('outbox_poller', {})
    .catch(logEnqueueFailure('outbox_poller'));
  const outboxTimer = setInterval(
    () => queue.enqueue('outbox_poller', {}).catch(() => undefined),
    config.pollIntervalMs,
  );

  queue
    .enqueue('webhook_job_poller', {})
    .catch(logEnqueueFailure('webhook_job_poller'));
  const webhookJobPollerTimer = setInterval(
    () => queue.enqueue('webhook_job_poller', {}).catch(() => undefined),
    config.pollIntervalMs,
  );

  // Phase 4: sweep webhook_events for webhooks that were durably persisted
  // but never reached a consumer (gateway enqueue failed, gateway crashed
  // between persist and enqueue, or a gateway that fell back to an
  // in-memory store). Rows are leased with FOR UPDATE SKIP LOCKED, so every
  // worker replica can run this safely.
  queue
    .enqueue('webhook_event_recovery', {})
    .catch(logEnqueueFailure('webhook_event_recovery'));
  const webhookRecoveryTimer = setInterval(
    () => queue.enqueue('webhook_event_recovery', {}).catch(() => undefined),
    config.webhookRecoveryIntervalMs ?? 30_000,
  );

  // P1: Periodically rescue stuck processing jobs
  const reaperTimer = setInterval(async () => {
    const rescued = await queue.rescueStuckJobs();
    if (rescued > 0) {
      logger.info('rescued stuck processing jobs', { operation: 'reaper', status: 'rescued', rescued });
    }
  }, config.reconciliationIntervalMs);

  // P3-2: Worker health check HTTP server
  // Phase 19 (B13): /ready checks what the worker needs to do its job.
  const readiness = createWorkerReadiness({
    manager,
    store,
    redisUrl: config.redisUrl,
    providerState: () => providerStateSync.status(),
    eventBus,
    checkDatabase: checkDatabaseHealth,
  });
  const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT) || 3002;
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'worker',
        running: manager.isRunning(),
        concurrency: config.concurrency,
        providers: providers.length,
        timestamp: new Date().toISOString(),
      }));
    } else if (req.url === '/ready') {
      readiness().then(
        ({ httpStatus, body }) => {
          res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        },
        (err) => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'not-ready',
            service: 'worker',
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }));
        },
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT);

  logger.info('BIS workers running', {
    operation: 'startup',
    status: 'running',
    concurrency: config.concurrency,
    healthUrl: `http://localhost:${HEALTH_PORT}/health`,
  });

  // P3-3: Graceful shutdown with drain period
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down workers', { operation: 'shutdown', status: 'draining' });

    // Stop accepting new work
    clearInterval(healthTimer);
    clearInterval(retryTimer);
    clearInterval(reconTimer);
    clearInterval(reaperTimer);
    clearInterval(outboxTimer);
    clearInterval(webhookJobPollerTimer);
    clearInterval(webhookRecoveryTimer);
    providerStateSync.stop();
    healthServer.close();

    // Drain: wait for in-flight jobs to complete (max 30s)
    const drainDeadline = Date.now() + 30_000;
    while (manager.isRunning() && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    await manager.stop();
    await store.quit?.();
    logger.info('workers stopped', { operation: 'shutdown', status: 'stopped' });
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('worker bootstrap failed', {
    operation: 'startup',
    errorCode: 'WORKER_BOOTSTRAP_FAILED',
    status: 'failed',
    error: err,
  });
  process.exit(1);
});
