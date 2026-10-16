import { describe, it, expect } from 'vitest';
import { randomBytes, randomInt } from 'node:crypto';
import { API_KEY, TENANT_ID, OTHER_API_KEY, OTHER_TENANT_ID_HAULPRO } from './db';
import { requestFrom, type SimRuntime } from './harness';

/**
 * Phase 14 — gateway rate limiting, end to end over real HTTP against the
 * real services/api-gateway app (gap register C14, C15). One scenario set,
 * run against both limiter back-ends:
 *   - rate-limiting.simulation.test.ts        — in-memory limiter (no REDIS_URL);
 *   - rate-limiting.redis.simulation.test.ts  — RateLimiterRedis on a REAL,
 *     spawned redis-server (skipped when no redis-server is available).
 *
 * The gateway reads its limits once at module load, so each file boots it
 * with deliberately SMALL, real limits via rateLimitEnv() (not the harness's
 * 100000 default):
 *   general budget  RATE_LIMIT_MAX_REQUESTS      = LIMIT / minute
 *   strict budget   AUTH_RATE_LIMIT_MAX_REQUESTS = AUTH_LIMIT / minute
 * and a configured ADMIN_API_TOKEN, so admin requests reach the real
 * 403/200 paths instead of a blanket 503.
 *
 * Each scenario sends from its OWN loopback source address (127.x.y.z — all
 * of 127/8 is loopback on Linux), which is what the gateway sees as req.ip.
 * That isolates scenarios from each other and lets a scenario show that the
 * bucket follows the caller's address, not a header the caller picks.
 */

export const LIMIT = 5;
export const AUTH_LIMIT = 3;

export const RATE_LIMIT_ENV_KEYS = [
  'ADMIN_API_TOKEN',
  'RATE_LIMIT_MAX_REQUESTS',
  'RATE_LIMIT_WINDOW_MS',
  'AUTH_RATE_LIMIT_MAX_REQUESTS',
  'AUTH_RATE_LIMIT_WINDOW_MS',
];

export function rateLimitEnv(adminToken: string): Record<string, string> {
  return {
    ADMIN_API_TOKEN: adminToken,
    RATE_LIMIT_MAX_REQUESTS: String(LIMIT),
    RATE_LIMIT_WINDOW_MS: '60000',
    AUTH_RATE_LIMIT_MAX_REQUESTS: String(AUTH_LIMIT),
    AUTH_RATE_LIMIT_WINDOW_MS: '60000',
  };
}

const AUTH = { authorization: 'Bearer ' + API_KEY, 'x-tenant-id': TENANT_ID };
const OTHER_AUTH = { authorization: 'Bearer ' + OTHER_API_KEY, 'x-tenant-id': OTHER_TENANT_ID_HAULPRO };

export function registerRateLimitScenarios(getRuntime: () => SimRuntime, adminToken: string, label: string): void {
  const runPrefix = `127.${randomInt(1, 255)}.${randomInt(1, 255)}`;
  let nextHost = 2;
  const freshIp = () => `${runPrefix}.${nextHost++}`;
  const randomKey = () => 'bap_test_' + randomBytes(12).toString('hex');

  const send = (
    sourceIp: string,
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<number> => requestFrom(getRuntime().baseUrl, sourceIp, method, path, headers, body);

  async function sendMany(n: number, fn: (i: number) => Promise<number>): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await fn(i));
    return out;
  }

  // ---------------------------------------------------------------------------
  // C14 — the bucket must not be an attacker-chosen string
  // ---------------------------------------------------------------------------
  describe(`C14 — rate-limit identity cannot be minted per request (${label})`, () => {
    it('admin token guesses with a fresh random x-api-key on every request are still throttled by caller IP', async () => {
      const attacker = freshIp();
      const statuses = await sendMany(LIMIT * 2, () =>
        send(attacker, 'GET', '/api/dashboard/admin/verify', {
          'x-api-key': randomKey(),
          'x-admin-token': 'guess-' + randomBytes(6).toString('hex'),
        }),
      );
      // Exactly LIMIT guesses reach requireAdmin (403), every later one is refused.
      expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(403));
      expect(statuses.slice(LIMIT)).toEqual(Array(LIMIT).fill(429));

      // A throttled caller learns nothing even with the CORRECT token — no oracle.
      expect(await send(attacker, 'GET', '/api/dashboard/admin/verify', { 'x-admin-token': adminToken })).toBe(429);
      // ...while the same correct token from another address is accepted, so the
      // 403s above came from the real token check, not an unconfigured gate.
      expect(await send(freshIp(), 'GET', '/api/dashboard/admin/verify', { 'x-admin-token': adminToken })).toBe(200);
    });

    it('API-key guesses on /v1/api with a fresh random key per request are throttled by caller IP', async () => {
      const attacker = freshIp();
      const statuses = await sendMany(LIMIT * 2, () =>
        send(attacker, 'GET', '/v1/api/gateway/transaction/does-not-exist', {
          authorization: 'Bearer ' + randomKey(),
          'x-tenant-id': TENANT_ID,
        }),
      );
      expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(401));
      expect(statuses.slice(LIMIT)).toEqual(Array(LIMIT).fill(429));
      // Once the address is exhausted even a VALID key is refused before lookup,
      // so the gateway can't be used as a key-validity oracle.
      expect(await send(attacker, 'GET', '/v1/api/gateway/transaction/does-not-exist', AUTH)).toBe(429);
    });

    it('a concurrent burst of random-key guesses cannot race past the limit', async () => {
      const attacker = freshIp();
      const statuses = await Promise.all(
        Array.from({ length: LIMIT * 4 }, () =>
          send(attacker, 'GET', '/v1/api/gateway/transaction/does-not-exist', {
            authorization: 'Bearer ' + randomKey(),
            'x-tenant-id': TENANT_ID,
          }),
        ),
      );
      expect(statuses.filter((s) => s === 401).length).toBe(LIMIT);
      expect(statuses.filter((s) => s === 429).length).toBe(LIMIT * 3);
    });

    it('a random key sent to a /v1/api route that does not use API keys does not buy a fresh bucket', async () => {
      const attacker = freshIp();
      const statuses = await sendMany(LIMIT * 2, () =>
        send(attacker, 'POST', '/v1/api/auth/reset-password', { 'x-api-key': randomKey() }, {
          token: 'guess-' + randomBytes(8).toString('hex'),
          password: 'new-password-123',
        }),
      );
      expect(statuses.slice(0, LIMIT).every((s) => s !== 429)).toBe(true);
      expect(statuses.slice(LIMIT)).toEqual(Array(LIMIT).fill(429));
    });

    it('authenticated traffic keeps a per-application bucket and is not charged to the shared IP', async () => {
      const tenantServer = freshIp();
      const path = '/v1/api/gateway/transaction/does-not-exist';
      const first = await sendMany(LIMIT, () => send(tenantServer, 'GET', path, AUTH));
      expect(first.every((s) => s !== 429)).toBe(true);
      expect(await send(tenantServer, 'GET', path, AUTH)).toBe(429);

      // A different application from the SAME address has its own budget...
      expect(await send(tenantServer, 'GET', path, OTHER_AUTH)).not.toBe(429);
      // ...and the address itself was never charged for the authenticated calls.
      expect(await send(tenantServer, 'POST', '/v1/api/auth/reset-password', {}, { token: 'x', password: 'y-password-123' })).not.toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // C15 — high-value routes that had no rate limiting at all
  // ---------------------------------------------------------------------------
  describe(`C15 — previously unlimited high-value routes are rate limited (${label})`, () => {
    it('POST /refunds is throttled (invalid-key guesses charged to the caller IP)', async () => {
      const caller = freshIp();
      const statuses = await sendMany(LIMIT + 2, () =>
        send(caller, 'POST', '/refunds', { authorization: 'Bearer ' + randomKey(), 'x-tenant-id': TENANT_ID }, {
          payment_id: 'pay_x',
        }),
      );
      expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(401));
      expect(statuses.slice(LIMIT)).toEqual([429, 429]);
    });

    it('POST /v1/portal/auth/login is throttled on the strict budget per IP (password brute force)', async () => {
      const attacker = freshIp();
      const statuses = await sendMany(AUTH_LIMIT + 2, (i) =>
        send(attacker, 'POST', '/v1/portal/auth/login', {}, { email: 'victim@example.com', password: `guess-${i}-xxxx` }),
      );
      expect(statuses.slice(0, AUTH_LIMIT)).toEqual(Array(AUTH_LIMIT).fill(401));
      expect(statuses.slice(AUTH_LIMIT)).toEqual([429, 429]);
      // Per IP: another caller is unaffected.
      expect(await send(freshIp(), 'POST', '/v1/portal/auth/login', {}, { email: 'victim@example.com', password: 'other-guess' })).toBe(401);
    });

    it('POST /v1/portal/auth/signup is throttled on the strict budget per IP (signup abuse)', async () => {
      const caller = freshIp();
      const statuses = await sendMany(AUTH_LIMIT + 2, () => send(caller, 'POST', '/v1/portal/auth/signup', {}, {}));
      expect(statuses.slice(0, AUTH_LIMIT)).toEqual(Array(AUTH_LIMIT).fill(400));
      expect(statuses.slice(AUTH_LIMIT)).toEqual([429, 429]);
    });

    it('GET /v1/checkout/sessions/:token is throttled per IP (token enumeration)', async () => {
      const caller = freshIp();
      const statuses = await sendMany(LIMIT + 2, () =>
        send(caller, 'GET', '/v1/checkout/sessions/cs_' + randomBytes(8).toString('hex')),
      );
      expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(404));
      expect(statuses.slice(LIMIT)).toEqual([429, 429]);
    });

    it('POST /v1/checkout/sessions/:token/pay is throttled on the strict budget per IP (card testing)', async () => {
      const caller = freshIp();
      const statuses = await sendMany(AUTH_LIMIT + 2, () =>
        send(caller, 'POST', '/v1/checkout/sessions/cs_' + randomBytes(8).toString('hex') + '/pay', {}, { paymentMethod: 'card' }),
      );
      expect(statuses.slice(0, AUTH_LIMIT)).toEqual(Array(AUTH_LIMIT).fill(404));
      expect(statuses.slice(AUTH_LIMIT)).toEqual([429, 429]);
    });
  });
}
