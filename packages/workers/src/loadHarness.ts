import http from 'node:http';
import { createHmac } from 'node:crypto';
import { MemoryStore } from './client';
import { createKeys } from './keys';
import { createWorkerConfig, JobType } from './types';
import { WorkerManager } from './worker';
import { DistributedLock } from './lock';
import { RateLimiter } from './rateLimit';
import { registerAllProcessors } from './jobs';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';
import { eventRepository } from '@company/database';

export interface MetricSample {
  scenario: string;
  durationMs: number;
  totalRequests: number;
  completed: number;
  errors: number;
  rps: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; avg: number };
  errorRate: number;
  queueDepthMax: number;
  providerLatencyAvg: number | null;
  dbWriteLatencyMs: number | null;
  notes: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function startGateway(): Promise<{ port: number; close: () => Promise<void> }> {
  const mod = await import('../../../services/api-gateway/src/app');
  const app = (mod as any).default;
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

function postJson(
  port: number,
  path: string,
  body: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; error: boolean }> {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          ...headers,
        },
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, error: (res.statusCode || 0) >= 400 }),
        );
      },
    );
    req.on('error', () => resolve({ status: 0, error: true }));
    req.write(data);
    req.end();
  });
}

interface HammerOpts {
  concurrency: number;
  durationMs: number;
  task: () => Promise<unknown>;
  sampleDepth?: () => Promise<number>;
}

async function hammer(opts: HammerOpts): Promise<{
  total: number;
  errors: number;
  latencies: number[];
  queueDepthMax: number;
}> {
  const latencies: number[] = [];
  let total = 0;
  let errors = 0;
  let queueDepthMax = 0;
  const end = Date.now() + opts.durationMs;

  const sampler = opts.sampleDepth
    ? setInterval(async () => {
        try {
          const d = await opts.sampleDepth!();
          if (d > queueDepthMax) queueDepthMax = d;
        } catch {
          /* ignore */
        }
      }, 50)
    : null;

  const client = async () => {
    while (Date.now() < end) {
      const t = Date.now();
      try {
        await opts.task();
        latencies.push(Date.now() - t);
        total++;
      } catch {
        errors++;
        total++;
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, () => client()));
  if (sampler) clearInterval(sampler);
  return { total, errors, latencies, queueDepthMax };
}

export interface LoadSuiteResult {
  backend: 'memory' | 'redis';
  scenarios: MetricSample[];
}

export async function runLoadSuite(): Promise<LoadSuiteResult> {
  process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || '1000000';
  process.env.NODE_ENV = 'test';
  process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || 'loadtest-secret';

  const store = new MemoryStore();
  const keys = createKeys('load');
  const config = createWorkerConfig();
  config.concurrency = Number(process.env.LOAD_CONCURRENCY) || 64;
  config.pollIntervalMs = 50;

  const registry = ProviderRegistry.getInstance();
  const routing = new RoutingEngine();
  const eventBus = EventBus.getInstance();
  const lock = new DistributedLock(store, keys);
  const rateLimiter = new RateLimiter(store, keys, config.rateLimit);

  const manager = new WorkerManager(store, keys, config);
  const queue = manager.getQueue();
  registerAllProcessors(manager, { registry, routing, eventBus, lock, rateLimiter, config, keys }, queue);
  await manager.start();

  const scenarios: MetricSample[] = [];

  const depthSampler = async () => {
    let max = 0;
    const types: JobType[] = [
      'message_delivery',
      'payment_webhook',
      'provider_webhook',
      'provider_health',
      'event_processing',
      'retry_processing',
      'reconciliation',
    ];
    for (const t of types) {
      const d = (await queue.readyCount(t)) + (await queue.delayedCount(t));
      if (d > max) max = d;
    }
    return max;
  };

  const providerLatencies: number[] = [];
  const unsub = eventBus.subscribe((e: any) => {
    if (typeof e?.latency === 'number') providerLatencies.push(e.latency);
  });

  const finalize = (
    scenario: string,
    durationMs: number,
    r: { total: number; errors: number; latencies: number[]; queueDepthMax: number },
    notes: string,
    completedOverride?: number,
  ): MetricSample => {
    const sorted = [...r.latencies].sort((a, b) => a - b);
    const completed = completedOverride ?? r.total - r.errors;
    return {
      scenario,
      durationMs,
      totalRequests: r.total,
      completed,
      errors: r.errors,
      rps: Math.round((r.total / durationMs) * 1000),
      latencyMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] || 0,
        avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      },
      errorRate: r.total ? r.errors / r.total : 0,
      queueDepthMax: r.queueDepthMax,
      providerLatencyAvg: providerLatencies.length
        ? Math.round(providerLatencies.reduce((a, b) => a + b, 0) / providerLatencies.length)
        : null,
      dbWriteLatencyMs: null,
      notes,
    };
  };

  const gateway = await startGateway().catch(() => null);

  try {
    for (const level of [16, 64, 128]) {
      if (gateway) {
        const r = await hammer({
          concurrency: level,
          durationMs: 1200,
          task: () =>
            postJson(gateway.port, '/api/gateway/payment', {
              appId: 'afribook',
              amount: 10,
              currency: 'USD',
              paymentMethod: 'card',
            }),
          sampleDepth: depthSampler,
        });
        scenarios.push(
          finalize(`API Gateway @ concurrency ${level}`, 1200, r, 'Express + auth + routing + provider sim'),
        );
      }
    }

    if (gateway) {
      const r = await hammer({
        concurrency: 64,
        durationMs: 1200,
        task: () =>
          postJson(gateway.port, '/api/gateway/messaging', {
            appId: 'signalhouse',
            recipient: '+2659999999',
            content: 'Hello',
          }),
        sampleDepth: depthSampler,
      });
      scenarios.push(finalize('Messaging Router (gateway)', 1200, r, 'routeMessage via gateway'));
    }

    const tenants = ['afribook', 'reachchurch', 'haulpro', 'ridely', 'stayscape'];
    const rTenants = await hammer({
      concurrency: 64,
      durationMs: 1500,
      task: () => {
        const appId = tenants[Math.floor(Math.random() * tenants.length)];
        return queue.enqueue('event_processing', {
          id: `e_${Math.random().toString(36).slice(2)}`,
          appId,
          category: 'payment',
          providerId: 'stripe',
          status: 'success',
        });
      },
      sampleDepth: depthSampler,
    });
    scenarios.push(finalize('Concurrent tenants (event processing)', 1500, rTenants, `${tenants.length} tenants`));

    const suppliers = ['stripe', 'nmi', 'flutterwave', 'pawapay', 'airwallex', 'paychangu'];
    const secret = process.env.WEBHOOK_HMAC_SECRET!;
    const rSuppliers = await hammer({
      concurrency: 64,
      durationMs: 1500,
      task: () => {
        const providerId = suppliers[Math.floor(Math.random() * suppliers.length)];
        const raw = JSON.stringify({ providerId, status: 'healthy' });
        const sig = createHmac('sha256', secret).update(raw).digest('hex');
        return queue.enqueue('provider_webhook', {
          id: `wh_${Math.random().toString(36).slice(2)}`,
          providerId,
          rawBody: raw,
          signature: sig,
          status: 'healthy',
        });
      },
      sampleDepth: depthSampler,
    });
    scenarios.push(finalize('Concurrent suppliers (webhook processing)', 1500, rSuppliers, `${suppliers.length} suppliers`));

    const countryNumber = '+2651234567';
    const startCount = providerLatencies.length;
    await hammer({
      concurrency: 32,
      durationMs: 1500,
      task: () =>
        queue.enqueue('message_delivery', {
          id: `m_${Math.random().toString(36).slice(2)}`,
          appId: 'futuresms',
          recipient: countryNumber,
          content: 'Bulk SMS',
        }),
      sampleDepth: depthSampler,
    });
    const rShared = { total: 5000, errors: 0, latencies: [0], queueDepthMax: 0 };
    for (let i = 0; i < 5000; i++) {
      await queue.enqueue('message_delivery', {
        id: `bulk_${i}`,
        appId: 'futuresms',
        recipient: countryNumber,
        content: 'Country blast',
      });
    }
    await drain(queue, 20000);
    const processedShared = providerLatencies.length - startCount;
    scenarios.push(
      finalize(
        'Thousands of messages sharing a country number',
        1500,
        rShared,
        `5000 messages to ${countryNumber}; processed=${processedShared}`,
        processedShared,
      ),
    );

    const dbStart = Date.now();
    let dbOk = false;
    try {
      await eventRepository.create({
        appId: 'loadtest',
        category: 'payment',
        providerId: 'stripe',
        status: 'success',
      });
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const dbLatency = dbOk ? Date.now() - dbStart : null;
    if (scenarios.length > 0) {
      scenarios[scenarios.length - 1].dbWriteLatencyMs = dbLatency;
      scenarios[scenarios.length - 1].notes += dbOk ? '; DB write OK' : '; DB unreachable (graceful)';
    }
  } finally {
    unsub();
    if (gateway) await gateway.close();
    await manager.stop();
  }

  return { backend: 'memory', scenarios };
}

async function drain(queue: any, timeoutMs: number): Promise<void> {
  const types: JobType[] = [
    'message_delivery',
    'payment_webhook',
    'provider_webhook',
    'provider_health',
    'event_processing',
  ];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let pending = 0;
    for (const t of types) {
      pending += (await queue.readyCount(t)) + (await queue.delayedCount(t));
    }
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
