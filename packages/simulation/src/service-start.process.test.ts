import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { freePort, redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Phase 23-24 (deployment artifacts + CI/CD gating) — each service booted
 * with its REAL production start command (`npm run start -w services/<svc>`,
 * the exact command the Railway service runs) via scripts/service-boot-smoke.ts:
 * /health 200, a well-formed /ready report, and a clean exit on SIGTERM sent
 * to the npm process.
 *
 * Before this phase both services had `"build": "tsc --noEmit"` and
 * `"start": "node dist/index.js"` — nothing ever produced dist/, so the start
 * command died with MODULE_NOT_FOUND (the live Railway outage) while every CI
 * gate stayed green. Separately, without `exec` in the start script, SIGTERM
 * to npm killed npm and its `sh -c` wrapper but never reached the service
 * process (orphaned, still serving, graceful shutdown never ran). Both
 * regressions fail this test.
 *
 * DATABASE_URL is pinned to a closed port (the database layer is neon-http
 * only, so no local database can satisfy it) so the processes never pick up a
 * real database from the repository's .env (dotenv does not override
 * variables that are already set). With a redis-server available the
 * services get a real Redis and every readiness dependency except the
 * database (and the provider state loaded from it) must be up.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
let redis: TestRedis | undefined;

afterAll(async () => {
  await redis?.stop();
});

async function smoke(service: 'api-gateway' | 'worker', env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  if (redisAvailable && !redis) redis = await startTestRedis();
  const redisUrl = redis?.url ?? `redis://127.0.0.1:${await freePort()}`;
  const adminToken = randomBytes(32).toString('hex');
  const child = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/service-boot-smoke.ts', service], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://p23:p23@127.0.0.1:1/p23_unreachable',
      REDIS_URL: redisUrl,
      REDIS_CONNECT_TIMEOUT_MS: '500',
      WORKER_QUEUE_PREFIX: `p23-boot-${randomBytes(4).toString('hex')}`,
      RATE_LIMIT_KEY_PREFIX: `p23-boot-rl-${randomBytes(4).toString('hex')}`,
      PORTAL_JWT_SECRET: randomBytes(32).toString('hex'),
      WEBHOOK_HMAC_SECRET: randomBytes(32).toString('hex'),
      SECRET_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      ADMIN_API_CREDENTIALS: `smoke:${createHash('sha256').update(adminToken).digest('hex')}`,
      ADMIN_API_TOKEN: '',
      PROVIDER_STATE_REFRESH_MS: '60000',
      ...(redis ? { SMOKE_ALLOW_FAILING: 'database,providers' } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  return { code, output };
}

describe('services boot with their production start command', () => {
  it('api-gateway (NODE_ENV=production): /health, /ready, clean SIGTERM exit', async () => {
    const { code, output } = await smoke('api-gateway', { NODE_ENV: 'production', PORT: String(await freePort()) });
    expect(output, output.slice(-4000)).toContain('PASS: api-gateway');
    expect(code).toBe(0);
  }, 120_000);

  // NODE_ENV=development: in production the worker deliberately refuses to
  // start without its persisted provider state (services/worker/src/index.ts),
  // which needs a reachable Neon database this environment cannot provide.
  it('worker: /health, /ready, clean SIGTERM exit', async () => {
    const { code, output } = await smoke('worker', { NODE_ENV: 'development', WORKER_HEALTH_PORT: String(await freePort()) });
    expect(output, output.slice(-4000)).toContain('PASS: worker');
    expect(code).toBe(0);
  }, 120_000);
});
