import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';
import { WorkerConfig } from '../types';
import { Keys } from '../keys';
import { DistributedLock } from '../lock';
import { RateLimiter } from '../rateLimit';

export interface JobDeps {
  registry: ProviderRegistry;
  routing: RoutingEngine;
  eventBus: EventBus;
  lock: DistributedLock;
  rateLimiter: RateLimiter;
  config: WorkerConfig;
  keys: Keys;
}

export class NeonWriteError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'NeonWriteError';
  }
}
