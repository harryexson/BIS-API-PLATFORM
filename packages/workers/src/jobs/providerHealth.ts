import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { providerHealthRepository, providerRepository } from '@company/database';

export function createProviderHealthProcessor(deps: JobDeps): JobProcessor {
  return async (job) => {
    const target = job.payload?.providerId as string | undefined;
    const configs = deps.registry.getAllConfigs();
    const candidates = target ? configs.filter((c) => c.id === target) : configs;

    const owner = `health_${target || 'all'}_${Math.random().toString(36).slice(2, 8)}`;
    const ttl = deps.config.retry.maxDelayMs;

    for (const cfg of candidates) {
      await deps.lock.withLock(`provider:${cfg.id}`, owner, ttl, async () => {
        const summary = await deps.registry.runHealthCheck(cfg.id);
        if (!summary) return;

        const provider = await providerRepository.findBySlug(cfg.id).catch(() => undefined);
        if (provider) {
          try {
            await providerHealthRepository.recordCheck({
              providerId: provider.id,
              checkType: 'liveness',
              status: summary.status,
              latencyMs: summary.latencyMs,
              errorMessage: summary.errorMessage,
            });
          } catch (err) {
            // P1: Fail on DB error so health check data is not silently lost
            console.error('[provider_health] Neon write failed — failing job for retry', err);
            throw new Error('provider_health: database write failed — retrying');
          }
        }

        deps.registry.updateManagement(cfg.id, {
          health: summary.status,
          lastSuccessfulRequest: summary.status === 'healthy' ? summary.checkedAt : undefined,
          errorRate: summary.status === 'down' ? 100 : summary.status === 'degraded' ? 50 : 0,
        });
      });
    }
  };
}
