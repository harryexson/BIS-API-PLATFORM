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

  console.log('===============================================');
  console.log(`BIS WORKERS RUNNING (concurrency=${config.concurrency})`);
  console.log('===============================================');
  const shutdown = async () => {
    console.log('Shutting down workers...');
    clearInterval(healthTimer);
    clearInterval(retryTimer);
    clearInterval(reconTimer);
    await manager.stop();
    await store.quit?.();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Worker bootstrap failed', err);
  process.exit(1);
});
