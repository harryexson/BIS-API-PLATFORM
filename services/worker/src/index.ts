import { createServer } from 'node:http';
import { ProviderRegistry } from '@company/providers';
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

async function main(): Promise<void> {
  const config = createWorkerConfig();
  const store = await createStore(config.redisUrl);
  const keys = createKeys(config.queuePrefix);

  const manager = new WorkerManager(store, keys, config);
  const queue = manager.getQueue();

  const registry = ProviderRegistry.getInstance();
  const routing = new RoutingEngine();
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
    console.log(`[reaper] rescued ${rescued} stuck processing jobs`);
  }

  await manager.start();

  const providers = registry.getAllConfigs().map((c) => c.id);

  const enqueueProviderHealth = () => {
    for (const id of providers) {
      queue.enqueue('provider_health', { providerId: id }).catch((e) =>
        console.error('[scheduler] provider_health enqueue failed', e),
      );
    }
  };

  enqueueProviderHealth();
  const healthTimer = setInterval(enqueueProviderHealth, config.providerHealthIntervalMs);

  queue
    .enqueue('retry_processing', {})
    .catch((e) => console.error('[scheduler] retry_processing enqueue failed', e));
  const retryTimer = setInterval(
    () => queue.enqueue('retry_processing', {}).catch(() => undefined),
    config.retryProcessingIntervalMs,
  );

  queue
    .enqueue('reconciliation', {})
    .catch((e) => console.error('[scheduler] reconciliation enqueue failed', e));
  const reconTimer = setInterval(
    () => queue.enqueue('reconciliation', {}).catch(() => undefined),
    config.reconciliationIntervalMs,
  );

  // P1: Periodically rescue stuck processing jobs
  const reaperTimer = setInterval(async () => {
    const rescued = await queue.rescueStuckJobs();
    if (rescued > 0) {
      console.log(`[reaper] rescued ${rescued} stuck processing jobs`);
    }
  }, config.reconciliationIntervalMs);

  // P3-2: Worker health check HTTP server
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
      const ready = manager.isRunning();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: ready ? 'ready' : 'not-ready',
        service: 'worker',
        running: manager.isRunning(),
        timestamp: new Date().toISOString(),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT);

  console.log('===============================================');
  console.log(`BIS WORKERS RUNNING (concurrency=${config.concurrency})`);
  console.log(`Worker health: http://localhost:${HEALTH_PORT}/health`);
  console.log('===============================================');

  // P3-3: Graceful shutdown with drain period
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down workers...');

    // Stop accepting new work
    clearInterval(healthTimer);
    clearInterval(retryTimer);
    clearInterval(reconTimer);
    clearInterval(reaperTimer);
    healthServer.close();

    // Drain: wait for in-flight jobs to complete (max 30s)
    const drainDeadline = Date.now() + 30_000;
    while (manager.isRunning() && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    await manager.stop();
    await store.quit?.();
    console.log('Workers stopped.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Worker bootstrap failed', err);
  process.exit(1);
});
