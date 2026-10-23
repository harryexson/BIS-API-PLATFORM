import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import { randomBytes } from 'node:crypto';
import { clearDb, seedReachChurch, installDatabaseMock } from './db';
import { createSimulation, type SimRuntime } from './harness';

/**
 * Phase 20-21 (gap register C7) — a gateway configured ONLY with the legacy
 * shared ADMIN_API_TOKEN (no ADMIN_API_CREDENTIALS), over real HTTP:
 *   - outside production it still works (local development, older suites),
 *     but as an explicitly IDENTIFIED legacy credential, not "whoever";
 *   - in production the shared, identity-less token is refused: admin auth
 *     answers 503 "not configured" and /ready names ADMIN_API_CREDENTIALS as
 *     missing — so a production deployment cannot keep running admin
 *     traffic on one shared secret.
 */

const LEGACY = 'p20-legacy-' + randomBytes(12).toString('hex');
const ENV_KEYS = ['ADMIN_API_TOKEN', 'ADMIN_API_CREDENTIALS', 'NODE_ENV', 'PORTAL_JWT_SECRET', 'SECRET_ENCRYPTION_KEY', 'REDIS_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe('C7 — the legacy shared ADMIN_API_TOKEN', () => {
  let runtime: SimRuntime;

  beforeAll(async () => {
    delete process.env.ADMIN_API_CREDENTIALS;
    process.env.REDIS_URL = 'memory';
    clearDb();
    seedReachChurch();
    runtime = await createSimulation({
      env: {
        ADMIN_API_TOKEN: LEGACY,
        PORTAL_JWT_SECRET: 'p20-portal-jwt-secret',
        SECRET_ENCRYPTION_KEY: 'p20-secret-encryption-key-0123456789',
      },
    });
  }, 30_000);

  afterEach(() => {
    process.env.NODE_ENV = savedEnv.NODE_ENV ?? 'test';
  });

  afterAll(async () => {
    await runtime?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('outside production: accepted, as the explicit identity legacy-admin-token', async () => {
    const res = await runtime.get('/api/dashboard/admin/verify', { 'x-admin-token': LEGACY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ adminId: 'legacy-admin-token', legacySharedToken: true });
  });

  it('in production: refused (503 not configured), and /ready reports the missing named credentials', async () => {
    process.env.NODE_ENV = 'production';
    const res = await runtime.get('/api/dashboard/admin/verify', { 'x-admin-token': LEGACY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Admin access not configured' });

    const ready = await runtime.get('/ready');
    const body = await ready.json();
    expect(ready.status).toBe(503);
    expect(body.missingSecrets).toContain('ADMIN_API_CREDENTIALS');
    expect(body.failing).toContain('secrets');
  });
});
