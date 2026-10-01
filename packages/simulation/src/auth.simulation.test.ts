import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { dbState, clearDb, installDatabaseMock } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including the new customer-account auth routes — is
// the REAL code (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Customer account auth — signup/login/session/verification/reset\n`);

let runtime: SimRuntime;

beforeAll(async () => {
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

beforeEach(() => {
  clearDb();
});

function signupPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: 'owner@reachchurch.example',
    password: 'correct-horse-battery-staple',
    name: 'Jane Owner',
    applicationName: 'Reach Church',
    applicationSlug: 'reach-church',
    ...overrides,
  };
}

describe('POST /v1/api/auth/signup', () => {
  it('creates an account + application and returns a usable API key and dev-mode verification token', async () => {
    const res = await runtime.post('/v1/api/auth/signup', signupPayload());
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.user.email).toBe('owner@reachchurch.example');
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.application.slug).toBe('reach-church');
    expect(body.apiKey.raw).toBeTruthy();
    expect(body.emailVerificationToken).toBeTruthy();

    // The issued API key actually authenticates against the gateway.
    const gatewayCheck = await runtime.get('/v1/api/gateway/providers', {
      authorization: `Bearer ${body.apiKey.raw}`,
      'x-tenant-id': 'whatever',
    });
    // Not asserting 200 here — no tenant is linked yet — just that the key
    // itself is recognized (i.e. not a 401 "Invalid API key").
    expect(gatewayCheck.status).not.toBe(401);
  });

  it('rejects a duplicate signup email with 409', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());
    const res = await runtime.post(
      '/v1/api/auth/signup',
      signupPayload({ applicationName: 'Other App', applicationSlug: 'other-app' }),
    );
    expect(res.status).toBe(409);
  });

  it('rejects a short password with 400', async () => {
    const res = await runtime.post('/v1/api/auth/signup', signupPayload({ password: 'short' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing applicationSlug with 400', async () => {
    const res = await runtime.post('/v1/api/auth/signup', signupPayload({ applicationSlug: undefined }));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/api/auth/login + session-authed routes', () => {
  it('logs in and can then call /auth/me with the returned session token', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());

    const loginRes = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'correct-horse-battery-staple',
    });
    expect(loginRes.status).toBe(200);
    const { token } = await loginRes.json();
    expect(token).toMatch(/^sess_/);

    const meRes = await runtime.get('/v1/api/auth/me', { authorization: `Bearer ${token}` });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json();
    expect(meBody.user.email).toBe('owner@reachchurch.example');
  });

  it('rejects wrong credentials with 401', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());
    const res = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'totally-wrong',
    });
    expect(res.status).toBe(401);
  });

  it('rejects /auth/me without a session token', async () => {
    const res = await runtime.get('/v1/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects /auth/me after logout revokes the session', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());
    const loginRes = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'correct-horse-battery-staple',
    });
    const { token } = await loginRes.json();

    const logoutRes = await runtime.post('/v1/api/auth/logout', {}, { authorization: `Bearer ${token}` });
    expect(logoutRes.status).toBe(204);

    const meRes = await runtime.get('/v1/api/auth/me', { authorization: `Bearer ${token}` });
    expect(meRes.status).toBe(401);
  });

  it('locks the account after repeated failed logins', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());
    for (let i = 0; i < 5; i++) {
      await runtime.post('/v1/api/auth/login', { email: 'owner@reachchurch.example', password: 'wrong' });
    }
    const res = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'correct-horse-battery-staple',
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/locked/i);
  });
});

describe('POST /v1/api/auth/verify-email', () => {
  it('verifies email with the signup-issued token', async () => {
    const signupRes = await runtime.post('/v1/api/auth/signup', signupPayload());
    const { emailVerificationToken } = await signupRes.json();

    const res = await runtime.post('/v1/api/auth/verify-email', { token: emailVerificationToken });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.emailVerifiedAt).toBeTruthy();
  });

  it('rejects an unknown token with 400', async () => {
    const res = await runtime.post('/v1/api/auth/verify-email', { token: 'not-a-real-token' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/api/auth/request-password-reset + reset-password', () => {
  it('resets the password end to end and revokes the prior session', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());
    const loginRes = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'correct-horse-battery-staple',
    });
    const { token: oldToken } = await loginRes.json();

    const resetReq = await runtime.post('/v1/api/auth/request-password-reset', {
      email: 'owner@reachchurch.example',
    });
    expect(resetReq.status).toBe(200);
    const { passwordResetToken } = await resetReq.json();
    expect(passwordResetToken).toBeTruthy();

    const resetRes = await runtime.post('/v1/api/auth/reset-password', {
      token: passwordResetToken,
      password: 'a-brand-new-password-999',
    });
    expect(resetRes.status).toBe(200);

    // Old session no longer works.
    const meRes = await runtime.get('/v1/api/auth/me', { authorization: `Bearer ${oldToken}` });
    expect(meRes.status).toBe(401);

    // New password works, old one doesn't.
    const oldLogin = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'correct-horse-battery-staple',
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await runtime.post('/v1/api/auth/login', {
      email: 'owner@reachchurch.example',
      password: 'a-brand-new-password-999',
    });
    expect(newLogin.status).toBe(200);
  });

  it('returns a generic 200 for an unknown email (no account enumeration)', async () => {
    const res = await runtime.post('/v1/api/auth/request-password-reset', { email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passwordResetToken).toBeUndefined();
  });
});

describe('database state', () => {
  it('signup writes a real row into the mocked users table', async () => {
    await runtime.post('/v1/api/auth/signup', signupPayload());
    expect(dbState.users).toHaveLength(1);
    expect(dbState.users[0].email).toBe('owner@reachchurch.example');
    // The stored hash is never the plaintext password.
    expect(dbState.users[0].passwordHash).not.toContain('correct-horse-battery-staple');
  });
});
