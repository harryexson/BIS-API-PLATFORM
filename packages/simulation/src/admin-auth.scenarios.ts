import { describe, it, expect } from 'vitest';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { waitFor, type SimRuntime } from './harness';

/**
 * Phase 20-21 — admin endpoint + SSE stream security (gap register C7,
 * PHASE14-06; also PHASE6-03 and C18's CRM authorName), end to end over real
 * HTTP against the real services/api-gateway app. One scenario set, run by:
 *   - admin-auth.simulation.test.ts            — in-memory database double, in-memory limiter;
 *   - admin-auth.redis.simulation.test.ts      — failed-attempt counter on a REAL redis-server;
 *   - admin-auth.postgres.integration.test.ts  — audit_logs / CRM rows in a REAL PostgreSQL.
 *
 * The gateway is booted with TWO named admin credentials (alice, bob) via
 * ADMIN_API_CREDENTIALS, a legacy ADMIN_API_TOKEN that must be IGNORED once
 * named credentials exist, a dedicated failed-attempt limit of
 * ADMIN_FAILURES per minute, and the harness's huge general per-IP budget —
 * so every 429 below comes from the dedicated counter, never the general one.
 *
 * Anything sending WRONG tokens uses its own loopback source address
 * (127.x.y.z), which is what the gateway counts failures against.
 */

export const ADMIN_FAILURES = 3;

export const ADMIN_AUTH_ENV_KEYS = [
  'ADMIN_API_CREDENTIALS',
  'ADMIN_API_TOKEN',
  'ADMIN_AUTH_MAX_FAILURES',
  'ADMIN_AUTH_FAILURE_WINDOW_MS',
  'SECRET_ENCRYPTION_KEY',
];

export interface AdminTokens {
  alice: string;
  bob: string;
  legacy: string;
}

export function newAdminTokens(): AdminTokens {
  return {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    legacy: 'legacy-shared-' + randomBytes(16).toString('hex'),
  };
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function adminAuthEnv(tokens: AdminTokens): Record<string, string> {
  return {
    ADMIN_API_CREDENTIALS: `alice:${sha256Hex(tokens.alice)},bob:${sha256Hex(tokens.bob)}`,
    ADMIN_API_TOKEN: tokens.legacy,
    ADMIN_AUTH_MAX_FAILURES: String(ADMIN_FAILURES),
    ADMIN_AUTH_FAILURE_WINDOW_MS: '60000',
    SECRET_ENCRYPTION_KEY: 'p20-secret-encryption-key-' + randomBytes(16).toString('hex'),
  };
}

export interface AdminAuthWorld {
  runtime: SimRuntime;
  tokens: AdminTokens;
  /** An application id the CRM routes accept (a "customer"). */
  customerId: string;
  /** Make audit_logs writes fail (a real DB fault on Postgres), or restore them. */
  setAuditWritesFailing(failing: boolean): Promise<void>;
  /** How many customer notes exist for customerId (straight from the store). */
  countNotes(): Promise<number>;
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}

/** One request from a chosen loopback source address; resolves with status, headers and body. */
export function send(
  baseUrl: string,
  sourceIp: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  const url = new URL(baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method,
        localAddress: sourceIp,
        agent: false,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function registerAdminAuthScenarios(getWorld: () => AdminAuthWorld, label: string): void {
  const runPrefix = `127.${randomInt(1, 255)}.${randomInt(1, 255)}`;
  let nextHost = 2;
  const freshIp = () => `${runPrefix}.${nextHost++}`;
  // One stable address for well-behaved admin traffic (never sends a wrong token).
  const adminIp = `${runPrefix}.1`;

  const w = () => getWorld();
  const as = (who: 'alice' | 'bob') => ({ 'x-admin-token': w().tokens[who] });
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown, ip = adminIp) =>
    send(w().runtime.baseUrl, ip, method, path, headers, body);

  async function auditRows(actorId: string): Promise<any[]> {
    const res = await call('GET', `/api/dashboard/admin/audit-logs?actorId=${encodeURIComponent(actorId)}&limit=500`, as('bob'));
    expect(res.status).toBe(200);
    return res.json.data;
  }
  async function deniedRows(): Promise<any[]> {
    // Denied attempts have no actor; read them through the unfiltered listing.
    const res = await call('GET', '/api/dashboard/admin/audit-logs?limit=500', as('bob'));
    expect(res.status).toBe(200);
    return res.json.data.filter((r: any) => r.actorId === null);
  }

  // -------------------------------------------------------------------------
  // C7 (1) — no credential in the URL
  // -------------------------------------------------------------------------
  describe(`C7 — admin credentials are never accepted from the query string (${label})`, () => {
    it('?token= is refused with 400 and never evaluated — even when it is a valid token, and even with a valid header too', async () => {
      const { alice } = w().tokens;
      const onlyQuery = await call('GET', `/api/dashboard/admin/verify?token=${alice}`);
      expect(onlyQuery.status).toBe(400);
      expect(onlyQuery.json.code).toBe('admin_token_in_query');

      const both = await call('GET', `/api/dashboard/admin/verify?token=${alice}`, as('alice'));
      expect(both.status).toBe(400);

      for (const name of ['admin_token', 'adminToken', 'x-admin-token', 'access_token']) {
        expect((await call('GET', `/api/dashboard/admin/verify?${name}=${alice}`)).status).toBe(400);
      }
      // The header alone is the one accepted transport.
      expect((await call('GET', '/api/dashboard/admin/verify', as('alice'))).status).toBe(200);
    });

    it('the SSE stream no longer accepts ?token= (the old EventSource fallback): 400 JSON, not an event stream', async () => {
      const res = await call('GET', `/api/dashboard/stream?token=${w().tokens.alice}`);
      expect(res.status).toBe(400);
      expect(String(res.headers['content-type'])).toContain('application/json');
      expect(res.json.code).toBe('admin_token_in_query');
    });

    it('a query-string attempt is audited as denied — and the token itself is recorded nowhere', async () => {
      await call('GET', `/api/dashboard/providers?token=${w().tokens.alice}`);
      await waitFor(async () => (await deniedRows()).some((r) => r.details?.reason === 'token_in_query_string'), {
        label: 'query-token denial audited',
      });
      const all = await call('GET', '/api/dashboard/admin/audit-logs?limit=500', as('bob'));
      expect(all.text).not.toContain(w().tokens.alice);
    });
  });

  // -------------------------------------------------------------------------
  // C7 (2)+(3) — per-admin identity, constant-time comparison
  // -------------------------------------------------------------------------
  describe(`C7 — each admin credential is independently identified (${label})`, () => {
    it('alice and bob each authenticate as themselves', async () => {
      const a = await call('GET', '/api/dashboard/admin/verify', as('alice'));
      const b = await call('GET', '/api/dashboard/admin/verify', as('bob'));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.json).toMatchObject({ ok: true, adminId: 'alice', legacySharedToken: false });
      expect(b.json).toMatchObject({ ok: true, adminId: 'bob', legacySharedToken: false });
    });

    it('the shared legacy ADMIN_API_TOKEN is NOT accepted once named credentials are configured', async () => {
      const res = await call('GET', '/api/dashboard/admin/verify', { 'x-admin-token': w().tokens.legacy }, undefined, freshIp());
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('admin_auth_invalid');
    });

    it('near-miss tokens of every length are refused cleanly (403, never a 500 from a length mismatch)', async () => {
      const { alice } = w().tokens;
      const variants = [
        alice.slice(0, -1), // one char short
        alice + '0', // one char long
        alice.toUpperCase(), // same length, different bytes
        'x', // length 1
        'y'.repeat(1024), // the longest token hashed
        'z'.repeat(1025), // over the limit: refused before hashing
        sha256Hex(alice), // the CONFIGURED hash is not a credential
      ];
      for (const v of variants) {
        // own address per variant: this test is about comparison, not lockout
        const res = await call('GET', '/api/dashboard/admin/verify', { 'x-admin-token': v }, undefined, freshIp());
        expect(res.status).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  // C7 compounding finding — GET /api/dashboard/providers
  // -------------------------------------------------------------------------
  describe(`C7 — GET /api/dashboard/providers requires admin auth (${label})`, () => {
    it('anonymous: 403 and no provider data; admin: 200 with the provider views', async () => {
      const anon = await call('GET', '/api/dashboard/providers');
      expect(anon.status).toBe(403);
      expect(anon.text).not.toContain('stripe');

      const admin = await call('GET', '/api/dashboard/providers', as('bob'));
      expect(admin.status).toBe(200);
      expect(Array.isArray(admin.json)).toBe(true);
      expect(admin.json.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Every admin route, enumerated from the live Express router
  // -------------------------------------------------------------------------
  describe(`C7 — no admin/observability route is reachable without a credential (${label})`, () => {
    it('every registered /api/dashboard/* and /api/observability/* route answers 403 to an anonymous caller', async () => {
      const gateway = await import('../../../services/api-gateway/src/app');
      const stack = ((gateway.default as any)._router?.stack ?? []) as any[];
      const routes: Array<{ method: string; path: string }> = [];
      for (const layer of stack) {
        const route = layer.route;
        if (!route || typeof route.path !== 'string') continue;
        if (!route.path.startsWith('/api/dashboard') && !route.path.startsWith('/api/observability')) continue;
        for (const method of Object.keys(route.methods)) routes.push({ method: method.toUpperCase(), path: route.path });
      }
      // 44 admin routes at the time of writing: the 42 that already had
      // requireAdmin, GET /api/dashboard/providers (which had NO auth), and
      // Phase 20-21's GET /api/dashboard/admin/audit-logs. New ones are
      // covered automatically by the blanket guard and by this enumeration.
      expect(routes.length).toBeGreaterThanOrEqual(44);

      const ip = freshIp(); // anonymous requests never count as failed attempts, one address is fine
      const results: Array<{ route: string; status: number }> = [];
      for (const r of routes) {
        const path = r.path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
        const res = await call(r.method, path, {}, r.method === 'GET' ? undefined : {}, ip);
        results.push({ route: `${r.method} ${r.path}`, status: res.status });
      }
      expect(results.filter((r) => r.status !== 403)).toEqual([]);
      // An unknown path under the prefix is not a way around the guard either.
      expect((await call('GET', '/api/dashboard/not-a-route', {}, undefined, ip)).status).toBe(403);
      console.warn(`[C7] ${routes.length} admin routes enumerated from the live router — every one 403s without a credential`);
    });
  });

  // -------------------------------------------------------------------------
  // C7 (4) — audit: who, what, when, outcome — and identity used downstream
  // -------------------------------------------------------------------------
  describe(`C7 — every admin action is attributed to the admin who made it (${label})`, () => {
    it('a CRM note is authored by the authenticated admin; a body authorName is ignored (C18)', async () => {
      const res = await call(
        'POST',
        `/api/dashboard/customers/${w().customerId}/notes`,
        as('alice'),
        { body: 'p20 note body text', authorName: 'mallory' },
      );
      expect(res.status).toBe(201);
      expect(res.json.authorName).toBe('alice');
    });

    it('a ticket comment is authored by the authenticated admin, whatever the body claims', async () => {
      const ticket = await call('POST', `/api/dashboard/customers/${w().customerId}/tickets`, as('bob'), {
        subject: 'p20 ticket',
        description: 'p20',
      });
      expect(ticket.status).toBe(201);
      const comment = await call('POST', `/api/dashboard/tickets/${ticket.json.id}/comments`, as('bob'), {
        body: 'p20 comment',
        authorName: 'alice',
      });
      expect(comment.status).toBe(201);
      expect(comment.json.authorName).toBe('bob');
    });

    it('audit_logs records who did what, when, with what outcome — per admin, never cross-attributed', async () => {
      const before = Date.now();
      const note = await call('POST', `/api/dashboard/customers/${w().customerId}/notes`, as('alice'), {
        body: 'p20 audited body — must not be copied into the audit row',
      });
      expect(note.status).toBe(201);
      const secrets = await call('GET', '/api/dashboard/providers/stripe/secrets', as('alice'));
      expect(secrets.status).toBe(200);
      const missing = await call('GET', '/api/dashboard/customers/00000000-0000-4000-8000-000000000000', as('bob'));
      expect(missing.status).toBe(404);

      // This note's row: the only note POST whose body had just a `body` field.
      const isThisNote = (r: any) =>
        r.action === 'POST /api/dashboard/customers/:id/notes' && r.statusCode === 201 && JSON.stringify(r.details?.bodyFields) === '["body"]';
      let rows: any[] = [];
      await waitFor(
        async () => {
          rows = await auditRows('alice');
          return rows.some(isThisNote) && rows.some((r) => r.action === 'GET /api/dashboard/providers/:id/secrets' && r.outcome === 'success');
        },
        { label: "alice's actions completed in the audit log" },
      );
      const noteRow = rows.find(isThisNote)!;
      expect(noteRow).toMatchObject({ actorType: 'admin', actorId: 'alice', resource: 'admin_api', outcome: 'success', statusCode: 201 });
      expect(noteRow.details).toMatchObject({ method: 'POST', route: '/api/dashboard/customers/:id/notes', params: { id: w().customerId } });
      expect(noteRow.details.bodyFields).toEqual(['body']);
      expect(JSON.stringify(noteRow)).not.toContain('must not be copied');
      expect(new Date(noteRow.createdAt).getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(noteRow.ipAddress).toContain(adminIp);

      // bob's 404 is bob's, with its real outcome; none of bob's actions are alice's.
      let bobRows: any[] = [];
      await waitFor(async () => {
        bobRows = await auditRows('bob');
        return bobRows.some((r) => r.action === 'GET /api/dashboard/customers/:id' && r.statusCode === 404);
      }, { label: "bob's 404 audited" });
      expect(bobRows.find((r) => r.statusCode === 404)).toMatchObject({ actorId: 'bob', outcome: 'client_error' });
      expect(rows.every((r) => r.actorId === 'alice')).toBe(true);
      expect(rows.some((r) => r.action === 'GET /api/dashboard/customers/:id')).toBe(false);
    });

    it('a mutating admin request whose audit row cannot be written is refused (503) and changes nothing', async () => {
      const notesBefore = await w().countNotes();
      await w().setAuditWritesFailing(true);
      try {
        const res = await call('POST', `/api/dashboard/customers/${w().customerId}/notes`, as('alice'), { body: 'unaudited' });
        expect(res.status).toBe(503);
        expect(res.json.error.code).toBe('admin_audit_unavailable');
        // Reads are not blocked by an audit outage (they are still logged).
        expect((await call('GET', '/api/dashboard/admin/verify', as('alice'))).status).toBe(200);
      } finally {
        await w().setAuditWritesFailing(false);
      }
      expect(await w().countNotes()).toBe(notesBefore);
    });
  });

  // -------------------------------------------------------------------------
  // PHASE14-06 / C7 (5) — dedicated failed-attempt counting
  // -------------------------------------------------------------------------
  describe(`PHASE14-06 — failed admin attempts have their own, stricter counter (${label})`, () => {
    const wrong = () => ({ 'x-admin-token': 'guess-' + randomBytes(8).toString('hex') });

    it(`${ADMIN_FAILURES} wrong tokens are evaluated, then the address is locked out — even for a correct token — while other addresses are not`, async () => {
      const attacker = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < ADMIN_FAILURES + 2; i++) {
        statuses.push((await call('GET', '/api/dashboard/admin/verify', wrong(), undefined, attacker)).status);
      }
      expect(statuses).toEqual([...Array(ADMIN_FAILURES).fill(403), 429, 429]);

      const locked = await call('GET', '/api/dashboard/admin/verify', as('alice'), undefined, attacker);
      expect(locked.status).toBe(429); // no oracle: the right token learns nothing either
      expect(locked.json.code).toBe('admin_auth_locked');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

      expect((await call('GET', '/api/dashboard/admin/verify', as('alice'), undefined, freshIp())).status).toBe(200);
      // The general per-IP budget (100000 in this suite) was nowhere near: this
      // lockout is the dedicated counter, not the 100/min bucket of PHASE14-06.
      await waitFor(async () => (await deniedRows()).some((r) => r.action === 'admin.auth.locked' && r.ipAddress?.includes(attacker)), {
        label: 'lockout audited',
      });
      // ...once per lockout, not once per refused request.
      expect((await deniedRows()).filter((r) => r.action === 'admin.auth.locked' && r.ipAddress?.includes(attacker)).length).toBe(1);
    });

    it('a concurrent burst of wrong guesses gets exactly the allowed number of evaluations', async () => {
      const attacker = freshIp();
      const statuses = await Promise.all(
        Array.from({ length: 20 }, () => call('GET', '/api/dashboard/admin/verify', wrong(), undefined, attacker).then((r) => r.status)),
      );
      expect(statuses.filter((s) => s === 403).length).toBe(ADMIN_FAILURES);
      expect(statuses.filter((s) => s === 429).length).toBe(20 - ADMIN_FAILURES);
    });

    it('requests with NO token are not failed attempts (a logged-out console polling does not lock anyone out)', async () => {
      const ip = freshIp();
      for (let i = 0; i < ADMIN_FAILURES * 3; i++) {
        expect((await call('GET', '/api/dashboard/providers', {}, undefined, ip)).status).toBe(403);
      }
      expect((await call('GET', '/api/dashboard/admin/verify', as('alice'), undefined, ip)).status).toBe(200);
    });

    it('a successful login clears the address\'s failure count', async () => {
      const ip = freshIp();
      for (let i = 0; i < ADMIN_FAILURES - 1; i++) {
        expect((await call('GET', '/api/dashboard/admin/verify', wrong(), undefined, ip)).status).toBe(403);
      }
      expect((await call('GET', '/api/dashboard/admin/verify', as('bob'), undefined, ip)).status).toBe(200);
      const after: number[] = [];
      for (let i = 0; i < ADMIN_FAILURES + 1; i++) {
        after.push((await call('GET', '/api/dashboard/admin/verify', wrong(), undefined, ip)).status);
      }
      expect(after).toEqual([...Array(ADMIN_FAILURES).fill(403), 429]);
    });

    it('failed attempts are visible on their own: metrics counters and denied audit rows', async () => {
      const metrics = await call('GET', '/api/observability/metrics', as('bob'));
      expect(metrics.status).toBe(200);
      expect(metrics.json.counters.adminAuthFailures).toBeGreaterThanOrEqual(ADMIN_FAILURES);
      expect(metrics.json.counters.adminAuthLockedRejections).toBeGreaterThanOrEqual(1);
      const denied = await deniedRows();
      expect(denied.some((r) => r.action === 'admin.auth.denied' && r.details?.reason === 'invalid_token' && r.statusCode === 403)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // SSE stream (the "SSE stream security" half of Phase 20-21)
  // -------------------------------------------------------------------------
  describe(`SSE stream — header-authenticated and attributed (${label})`, () => {
    it('anonymous: 403; wrong token: 403; admin header: a live event stream, audited from open to close', async () => {
      expect((await call('GET', '/api/dashboard/stream')).status).toBe(403);
      expect((await call('GET', '/api/dashboard/stream', { 'x-admin-token': 'nope' }, undefined, freshIp())).status).toBe(403);

      const controller = new AbortController();
      const res = await fetch(`${w().runtime.baseUrl}/api/dashboard/stream`, {
        headers: { 'x-admin-token': w().tokens.bob },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('"type":"connected"');

      // Opened: audited at once, attributed to bob, while the stream is still open.
      await waitFor(async () => (await auditRows('bob')).some((r) => r.action.startsWith('GET /api/dashboard/stream') && r.outcome === 'started'), {
        label: 'stream open audited',
      });
      controller.abort();
      await waitFor(
        async () => (await auditRows('bob')).some((r) => r.action === 'GET /api/dashboard/stream' && r.outcome === 'stream_closed' && r.statusCode === 200),
        { label: 'stream close audited' },
      );
    });
  });
}
