import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { dbState, clearDb, seedReachChurch, installDatabaseMock } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — gateway — is the REAL code.
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] /ready dependency reporting\n`);

let runtime: SimRuntime;

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

describe('GET /ready', () => {
  it('reports database, rate-limiter, queue, and provider dependency status', async () => {
    const res = await runtime.get('/ready');
    const body = await res.json();

    expect(body.service).toBe('api-gateway');
    expect(body.dependencies).toHaveProperty('database');
    expect(body.dependencies).toHaveProperty('rateLimiter');
    expect(body.dependencies).toHaveProperty('queue');
    expect(body.dependencies).toHaveProperty('providers');
  });

  it('reports queue as "unconfigured" (not unhealthy) when REDIS_URL is unset — a degraded-but-known mode, not a failure', async () => {
    // The simulation harness runs with no REDIS_URL by default.
    expect(process.env.REDIS_URL).toBeFalsy();

    const res = await runtime.get('/ready');
    const body = await res.json();

    expect(body.dependencies.queue).toBe('unconfigured');
    // An unconfigured (not unreachable) queue backend must not fail readiness
    // by itself — the gateway still works via DB-persisted webhook fallback.
    expect(res.status).toBe(200);
    expect(body.status).toBe('ready');
  });

  it('database healthy reflects real DB reachability, not just process liveness', async () => {
    dbState.failEventWrites = true;
    try {
      const res = await runtime.get('/ready');
      const body = await res.json();
      expect(body.dependencies.database).toBe('unhealthy');
      expect(res.status).toBe(503);
    } finally {
      dbState.failEventWrites = false;
    }
  });
});
