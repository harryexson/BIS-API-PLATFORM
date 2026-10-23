import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { freePort, redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Phase 19 (gap register B13) — the REAL worker service
 * (services/worker/src/index.ts) booted as a genuinely separate OS process,
 * probed over HTTP on its health port. Before Phase 19 its /ready was
 * `manager.isRunning()` only, so both cases below answered 200 "ready":
 *  - Redis configured but unreachable: the worker's queue silently fell
 *    back to a private MemoryStore, so it polls a queue no gateway ever
 *    enqueues into;
 *  - no reachable database (every job that touches webhook_events/outbox/
 *    transactions fails).
 *
 * DATABASE_URL is pinned to a closed local port so the process can never
 * pick up a real database from the repository's .env (dotenv does not
 * override variables that are already set). The service's database layer is
 * neon-http only, so a reachable-database case can't be run in a separate
 * process here; that half is covered in-process by readiness*.test.ts.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const children: ChildProcess[] = [];
let redis: TestRedis | undefined;

afterEach(async () => {
  for (const c of children.splice(0)) {
    // SIGKILL the whole process group: tsx runs the service in a child node
    // process, and the worker's SIGTERM handler waits up to 30s for a drain.
    if (c.exitCode === null && c.pid) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        c.kill('SIGKILL');
      }
    }
  }
  await redis?.stop();
  redis = undefined;
});

async function bootWorker(redisUrl: string): Promise<{ port: number; child: ChildProcess; output: () => string }> {
  const port = await freePort();
  let output = '';
  const child = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['services/worker/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      REDIS_URL: redisUrl,
      REDIS_CONNECT_TIMEOUT_MS: '500',
      DATABASE_URL: 'postgresql://p19:p19@127.0.0.1:1/p19_unreachable',
      WORKER_HEALTH_PORT: String(port),
      WORKER_QUEUE_PREFIX: `p19-proc-${randomBytes(4).toString('hex')}`,
      WEBHOOK_HMAC_SECRET: 'p19-process-webhook-secret',
      SECRET_ENCRYPTION_KEY: 'p19-process-secret-encryption-key',
      PROVIDER_STATE_REFRESH_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  children.push(child);
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`worker exited early (${child.exitCode}):\n${output.slice(-2000)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`worker health port never came up:\n${output.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { port, child, output: () => output };
}

async function getReady(port: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/ready`);
  return { status: res.status, body: await res.json() };
}

describe('worker /ready in a separate OS process', () => {
  it('Redis configured but unreachable: the queue fell back to memory → 503, not "ready"', async () => {
    const deadRedis = `redis://127.0.0.1:${await freePort()}`;
    const { port, child, output } = await bootWorker(deadRedis);
    expect(child.pid).not.toBe(process.pid);
    // The process itself logged the silent fallback it is now refusing to call ready.
    expect(output()).toContain('falling back to in-memory store');

    const { status, body } = await getReady(port);
    expect(status).toBe(503);
    expect(body.status).toBe('not-ready');
    expect(body.running).toBe(true); // the old check — still true, and not enough
    expect(body.dependencies.queue).toBe('memory-fallback');
    expect(body.failing).toContain('queue');
    expect(body.failing).toContain('database');
  }, 60_000);

  it.skipIf(!redisAvailable)('real Redis, no reachable database: queue and EventBus reported connected, database named as the reason', async () => {
    redis = await startTestRedis();
    const { port } = await bootWorker(redis.url);
    let last: { status: number; body: any } | undefined;
    const deadline = Date.now() + 10_000;
    do {
      last = await getReady(port);
      if (last.body.dependencies?.eventBus === 'connected') break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);

    expect(last!.status).toBe(503);
    expect(last!.body.dependencies).toMatchObject({ running: 'running', queue: 'redis', eventBus: 'connected', secrets: 'configured' });
    expect(['unhealthy', 'unreachable']).toContain(last!.body.dependencies.database);
    expect([...last!.body.failing].sort()).toEqual(['database', 'providers']);
    expect(last!.body.dependencies.providers).toBe('not-loaded');
  }, 60_000);
});
