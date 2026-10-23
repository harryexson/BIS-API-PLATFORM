import { describe, it, expect } from 'vitest';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { requestFrom, type SimRuntime } from './harness';

/**
 * Phase 23-24 — gap register PHASE14-03 / PHASE20-02: client identity behind
 * a reverse proxy, end to end over real HTTP against the real
 * services/api-gateway app.
 *
 * Every request below arrives from ONE TCP peer — the "proxy" (a loopback
 * source address 127.x.y.1, which is what Express sees as the socket peer) —
 * carrying the X-Forwarded-For header a single appending proxy hop (Railway's
 * edge) would write: "<whatever the client sent>, <the client's real address>".
 * Run by:
 *   - trust-proxy.simulation.test.ts          — TRUST_PROXY=1 (one trusted hop);
 *   - trust-proxy-refused.simulation.test.ts  — TRUST_PROXY=true (blanket trust,
 *     refused at boot → X-Forwarded-For ignored, the pre-existing behaviour).
 *
 * Small real limits: general per-IP budget LIMIT/min, dedicated admin-failure
 * lockout after ADMIN_FAILURES wrong tokens.
 */

export const LIMIT = 5;
export const ADMIN_FAILURES = 3;

export const TRUST_PROXY_ENV_KEYS = [
  'TRUST_PROXY',
  'ADMIN_API_CREDENTIALS',
  'ADMIN_API_TOKEN',
  'ADMIN_AUTH_MAX_FAILURES',
  'ADMIN_AUTH_FAILURE_WINDOW_MS',
  'RATE_LIMIT_MAX_REQUESTS',
  'RATE_LIMIT_WINDOW_MS',
  'AUTH_RATE_LIMIT_MAX_REQUESTS',
  'AUTH_RATE_LIMIT_WINDOW_MS',
  'SECRET_ENCRYPTION_KEY',
  'REDIS_URL',
];

export function trustProxyEnv(trustProxy: string, aliceToken: string): Record<string, string> {
  return {
    TRUST_PROXY: trustProxy,
    ADMIN_API_CREDENTIALS: `alice:${createHash('sha256').update(aliceToken, 'utf8').digest('hex')}`,
    ADMIN_AUTH_MAX_FAILURES: String(ADMIN_FAILURES),
    ADMIN_AUTH_FAILURE_WINDOW_MS: '60000',
    RATE_LIMIT_MAX_REQUESTS: String(LIMIT),
    RATE_LIMIT_WINDOW_MS: '60000',
    AUTH_RATE_LIMIT_MAX_REQUESTS: String(LIMIT),
    AUTH_RATE_LIMIT_WINDOW_MS: '60000',
    SECRET_ENCRYPTION_KEY: 'p23-secret-encryption-key-' + randomBytes(16).toString('hex'),
  };
}

export function registerTrustProxyScenarios(
  getRuntime: () => SimRuntime,
  aliceToken: string,
  mode: 'one-trusted-hop' | 'refused',
): void {
  const net = `127.${randomInt(1, 255)}.${randomInt(1, 255)}`;
  // One "proxy" per scenario, so scenarios never share the proxy's own bucket.
  let nextProxy = 1;
  const freshProxy = () => `${net}.${nextProxy++}`;
  // Client addresses the proxy reports (TEST-NET-2, never a real caller).
  let nextClient = randomInt(1, 200);
  const freshClient = () => `198.51.100.${nextClient++}`;
  const spoofed = () => `203.0.113.${randomInt(1, 255)}`;

  /** What one appending proxy hop forwards: client-supplied XFF (if any), then the real client. */
  const viaProxy = (proxy: string, client: string, clientSentXff?: string, headers: Record<string, string> = {}) =>
    (method: string, path: string) =>
      requestFrom(getRuntime().baseUrl, proxy, method, path, {
        ...headers,
        'x-forwarded-for': clientSentXff ? `${clientSentXff}, ${client}` : client,
      });

  const checkoutLookup = () => '/v1/checkout/sessions/cs_' + randomBytes(8).toString('hex');

  async function sendMany(n: number, fn: () => Promise<number>): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(await fn());
    return out;
  }

  if (mode === 'one-trusted-hop') {
    describe('TRUST_PROXY=1 — per-IP limits follow the client the proxy reports', () => {
      it('two clients behind the same proxy get separate per-IP buckets (PHASE14-03)', async () => {
        const proxy = freshProxy();
        const a = freshClient();
        const b = freshClient();
        const fromA = await sendMany(LIMIT + 2, () => viaProxy(proxy, a)('GET', checkoutLookup()));
        expect(fromA.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(404));
        expect(fromA.slice(LIMIT)).toEqual([429, 429]);
        // Same TCP peer (the proxy), different reported client → own budget.
        expect(await viaProxy(proxy, b)('GET', checkoutLookup())).toBe(404);
      });

      it('a client cannot mint a fresh identity by sending its own X-Forwarded-For (no C14 regression)', async () => {
        const proxy = freshProxy();
        const attacker = freshClient();
        // A different forged left-most entry on every request; the proxy-appended
        // right-most entry (the real client) is what is trusted.
        const statuses = await sendMany(LIMIT + 3, () => viaProxy(proxy, attacker, spoofed())('GET', checkoutLookup()));
        expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(404));
        expect(statuses.slice(LIMIT)).toEqual([429, 429, 429]);
      });

      it('wrong admin tokens from one client lock out THAT client, not another admin behind the same proxy (PHASE20-02)', async () => {
        const proxy = freshProxy();
        const attacker = freshClient();
        const admin = freshClient();
        const guess = () => viaProxy(proxy, attacker, undefined, { 'x-admin-token': 'guess-' + randomBytes(6).toString('hex') });
        const guesses = await sendMany(ADMIN_FAILURES, () => guess()('GET', '/api/dashboard/admin/verify'));
        expect(guesses).toEqual(Array(ADMIN_FAILURES).fill(403));
        // The attacker's reported address is now locked — even with the right token.
        expect(await viaProxy(proxy, attacker, undefined, { 'x-admin-token': aliceToken })('GET', '/api/dashboard/admin/verify')).toBe(429);
        // Alice, behind the very same proxy, is not.
        expect(await viaProxy(proxy, admin, undefined, { 'x-admin-token': aliceToken })('GET', '/api/dashboard/admin/verify')).toBe(200);
      });

      it('a request that reaches the gateway directly (no X-Forwarded-For) is keyed on its TCP peer', async () => {
        const direct = freshProxy();
        const send = () => requestFrom(getRuntime().baseUrl, direct, 'GET', checkoutLookup());
        const statuses = await sendMany(LIMIT + 1, send);
        expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(404));
        expect(statuses[LIMIT]).toBe(429);
        // ...and a proxied client is not charged for it.
        expect(await viaProxy(freshProxy(), freshClient())('GET', checkoutLookup())).toBe(404);
      });
    });
  } else {
    describe('TRUST_PROXY=true is refused — X-Forwarded-For is ignored entirely', () => {
      it('a forged X-Forwarded-For buys no fresh bucket: every client behind the proxy shares the TCP peer\'s', async () => {
        const proxy = freshProxy();
        const statuses = await sendMany(LIMIT + 2, () => viaProxy(proxy, freshClient(), spoofed())('GET', checkoutLookup()));
        expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(404));
        expect(statuses.slice(LIMIT)).toEqual([429, 429]);
      });

      it('admin failures are counted against the TCP peer, whatever X-Forwarded-For says', async () => {
        const proxy = freshProxy();
        const guesses = await sendMany(ADMIN_FAILURES, () =>
          viaProxy(proxy, freshClient(), spoofed(), { 'x-admin-token': 'guess-' + randomBytes(6).toString('hex') })('GET', '/api/dashboard/admin/verify'),
        );
        expect(guesses).toEqual(Array(ADMIN_FAILURES).fill(403));
        // Blanket trust would have made each of these a new identity; refused, they all hit the peer.
        expect(await viaProxy(proxy, freshClient(), undefined, { 'x-admin-token': aliceToken })('GET', '/api/dashboard/admin/verify')).toBe(429);
      });
    });
  }
}
