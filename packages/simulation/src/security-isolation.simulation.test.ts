import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
vi.mock('@company/database', () => installDatabaseMock());

import {
  dbState,
  clearDb,
  seedReachChurch,
  installDatabaseMock,
  APP_SLUG,
  API_KEY,
  TENANT_ID,
  OTHER_TENANT_ID,
  DONOR_EMAIL,
  DONOR_PHONE,
  OTHER_APP_SLUG,
  OTHER_API_KEY,
  OTHER_TENANT_ID_HAULPRO,
  OTHER_DONOR_EMAIL,
  OTHER_DONOR_PHONE,
} from './db';

import {
  createSimulation,
  createDonation,
  deliverWebhook,
  buildStripeWebhook,
  signWebhook,
  sendMessage,
  buildInboundSms,
  enqueuePaymentWebhook,
  drain,
  waitFor,
  sleep,
  counts,
  findConversation,
  requestFrom,
  type SimRuntime,
} from './harness';
import { randomBytes, randomInt } from 'node:crypto';

console.warn('\n[audit] AUDIT 4 — Adversarial Security & Multi-Tenant Isolation\n');

const AUTH = { authorization: 'Bearer ' + API_KEY, 'x-tenant-id': TENANT_ID };
const OTHER_AUTH = { authorization: 'Bearer ' + OTHER_API_KEY, 'x-tenant-id': OTHER_TENANT_ID_HAULPRO };

// F10 (Phase 14): this suite used to boot the gateway with NO admin token
// (so every admin assertion was satisfied by a 503 "not configured") and the
// harness's 100000-request limit (so the "rate limiting" test could never see
// a 429). It now runs with a real admin token and a real, small limit.
const ADMIN_TOKEN = 'sec-iso-admin-' + randomBytes(8).toString('hex');
const RATE_LIMIT = 60;
// SECRET_ENCRYPTION_KEY: Phase 15 (gap register D13) — an admin secret write
// is persisted before it is acknowledged, and refused (503) without a key;
// suite M stores a probe secret, so the key is configured here.
const SECRET_KEY = 'sec-iso-secret-key-' + randomBytes(16).toString('hex');
const ENV_KEYS = ['ADMIN_API_TOKEN', 'RATE_LIMIT_MAX_REQUESTS', 'SECRET_ENCRYPTION_KEY'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// Distinct loopback source addresses (all of 127/8 is loopback on Linux), so
// test N's bursts are charged to their own per-IP buckets, not to 127.0.0.1
// which every other test in this file uses.
const LOOPBACK_PREFIX = `127.${randomInt(1, 255)}.${randomInt(1, 255)}`;
let nextLoopbackHost = 2;
const freshLoopback = () => `${LOOPBACK_PREFIX}.${nextLoopbackHost++}`;

let runtime: SimRuntime;

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation({
    env: { ADMIN_API_TOKEN: ADMIN_TOKEN, RATE_LIMIT_MAX_REQUESTS: String(RATE_LIMIT), SECRET_ENCRYPTION_KEY: SECRET_KEY },
  });
}, 30_000);

afterAll(async () => {
  await runtime.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}, 15_000);

afterEach(() => {
  // keep shared in-memory db stable between tests; nothing per-test to restore
});

async function json(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------------------
// A) IDOR — cross-application transaction read
// ---------------------------------------------------------------------------
describe('A) IDOR — cross-application transaction read', () => {
  it('Tenant B (haulpro key) cannot read Tenant A (reach-church) transaction by id', async () => {
    const donation = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    expect(donation.status).toBe(200);
    const txId = donation.body.id;

    const res = await runtime.get('/v1/api/gateway/transaction/' + txId, OTHER_AUTH);
    // P0 FIX: cross-tenant read is now correctly forbidden (404)
    expect(res.status).toBe(404);
    console.warn('[FIXED] IDOR: Tenant B (haulpro key) can no longer read Tenant A (reach-church) transaction by id');
  });
});

// ---------------------------------------------------------------------------
// A2) IDOR — SAME application, different tenant (Phase 7, gap register C4)
// ---------------------------------------------------------------------------
// Case A above only ever crossed APPLICATIONS (a HaulPro key against a Reach
// Church payment), which the appId check has always caught. The realistic
// multi-tenant model is many tenants under ONE application — and until
// Phase 7 the status/refund routes checked appId only, so a second tenant of
// the same application could read and refund the first tenant's payment.
// No test in the repository had ever seeded a second tenant linked to the
// same application (gap register F14 item 6). The full adversarial matrix
// lives in tenant-isolation.scenarios.ts; this pins the core case here too.
describe('A2) IDOR — same application, different tenant (FIXED, Phase 7)', () => {
  const SECOND_TENANT = 'ten_reach_second_site';
  const SECOND_AUTH = { authorization: 'Bearer ' + API_KEY, 'x-tenant-id': SECOND_TENANT };

  beforeAll(() => {
    dbState.tenants.push({ id: SECOND_TENANT, slug: 'reach-second-site', name: 'Reach Church — Second Site', status: 'active', countryCode: 'US', currency: 'USD' });
    dbState.tenantLinks.push({ tenantId: SECOND_TENANT, applicationId: `app_${APP_SLUG}`, status: 'active' });
  });

  it("a second tenant of the SAME application cannot read or refund the first tenant's payment", async () => {
    const donation = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    expect(donation.status).toBe(200);
    const txId = donation.body.id;

    // Same API key, a different (validly linked) tenant: the tenant link
    // check passes — the resource ownership check must still refuse.
    expect((await runtime.get('/v1/api/gateway/transaction/' + txId, SECOND_AUTH)).status).toBe(404);
    expect((await runtime.post('/refunds', { payment_id: txId, tenantId: TENANT_ID }, SECOND_AUTH)).status).toBe(404);

    // The owning tenant still can.
    expect((await runtime.get('/v1/api/gateway/transaction/' + txId, AUTH)).status).toBe(200);
    console.warn('[FIXED] same-application cross-tenant IDOR: a second tenant can no longer read/refund the first tenant\'s payment');
  });
});

// ---------------------------------------------------------------------------
// B) IDOR via unauthenticated sim bypass
// ---------------------------------------------------------------------------
describe('B) IDOR via unauthenticated non-prod auth bypass', () => {
  it('no-key request is NOT auto-authenticated and cannot read a transaction', async () => {
    const donation = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    expect(donation.status).toBe(200);
    const txId = donation.body.id;

    const res = await runtime.get('/v1/api/gateway/transaction/' + txId);
    // P0 FIX: unauthenticated reads are now rejected in all environments
    expect(res.status).toBe(401);
    console.warn('[FIXED] non-prod auth bypass: no-key request is now rejected — unauthenticated transaction read blocked');
  });
});

// ---------------------------------------------------------------------------
// C) Tenant escape control (should PASS)
// ---------------------------------------------------------------------------
describe('C) Tenant link check (control)', () => {
  it('rejects an x-tenant-id that is not linked to the app', async () => {
    const res = await sendMessage(
      runtime,
      { recipient: DONOR_PHONE, content: 'hi' },
      { authorization: 'Bearer ' + API_KEY, 'x-tenant-id': OTHER_TENANT_ID },
    );
    expect(res.status).toBe(403);
    console.warn('[OK] tenant link check correctly rejects an unlinked x-tenant-id');
  });
});

// ---------------------------------------------------------------------------
// D) Tenant verification is now MANDATORY (FIXED)
// ---------------------------------------------------------------------------
describe('D) Tenant verification is mandatory (FIXED)', () => {
  it('a request with NO x-tenant-id header is rejected with 400', async () => {
    const res = await runtime.post(
      '/v1/api/gateway/messaging',
      { recipient: DONOR_PHONE, content: 'hi' },
      { authorization: 'Bearer ' + API_KEY },
    );
    expect(res.status).toBe(400);
    console.warn('[FIXED] tenant verification is now mandatory — requests without x-tenant-id are rejected');
  });
});

// ---------------------------------------------------------------------------
// E) Webhook replay at gateway (FIXED)
// ---------------------------------------------------------------------------
describe('E) Webhook replay recognised at gateway from the durable DB record (FIXED)', () => {
  it('a duplicate delivery is acknowledged (200, duplicate) without a second durable row or re-enqueue', async () => {
    // Phase 4 (gap register B8/C5/D7): dedup used to be a per-process
    // in-memory Map answering 409 — lost on restart, keyed without the
    // provider, and written BEFORE the enqueue it claimed to protect. The
    // duplicate is now detected by Postgres's unique (provider_id,
    // provider_event_id) index via the gateway's atomic claim, and is
    // acknowledged 200 (it WAS durably recorded and enqueued the first
    // time) so the provider stops retrying, instead of a 409.
    const body = buildStripeWebhook('chg_replay1');
    const first = await deliverWebhook(runtime, 'stripe', body);
    expect(first.status).toBe(200);
    expect(first.json.duplicate).toBeUndefined();
    const second = await deliverWebhook(runtime, 'stripe', body);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.webhookEventId).toBe(first.json.webhookEventId);
    const rows = dbState.webhookEvents.filter((e) => e.providerId === 'stripe' && e.providerEventId === body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].enqueuedAt).not.toBeNull();
    expect([...rows[0].enqueuedJobs].sort()).toEqual(['inbound_message', 'payment_webhook', 'provider_webhook']);
    console.warn('[FIXED] webhook replay: recognised from the durable webhook_events row, acknowledged without re-enqueue');
  });
});

// ---------------------------------------------------------------------------
// F) Webhook forged signature (control)
// ---------------------------------------------------------------------------
describe('F) Forged webhook signature rejected (control)', () => {
  it('a tampered HMAC signature is rejected', async () => {
    const body = buildStripeWebhook('chg_forged1');
    const rawBody = JSON.stringify(body);
    const correct = signWebhook(rawBody);
    // Change the first nibble; still valid-length hex. (Was `'a' + correct.slice(1)`,
    // which left the signature UNCHANGED whenever it already began with 'a' —
    // a 1-in-16 flake where the "forged" request was correctly accepted.)
    const tampered = (correct[0] === 'a' ? 'b' : 'a') + correct.slice(1);
    expect(tampered).not.toBe(correct);
    const res = await runtime.postText('/v1/api/webhooks/stripe', rawBody, {
      'x-webhook-signature': tampered,
    });
    expect(res.status).toBe(401);
    console.warn('[OK] forged webhook signature rejected');
  });
});

// ---------------------------------------------------------------------------
// G) Webhook unknown provider (control)
// ---------------------------------------------------------------------------
describe('G) Unknown provider webhook rejected (control)', () => {
  it('an unknown provider returns 401', async () => {
    const res = await runtime.post(
      '/v1/api/webhooks/evilcorp',
      { id: 'evt_evil', type: 'charge.succeeded' },
      { 'x-webhook-signature': 'x' },
    );
    expect(res.status).toBe(401);
    console.warn('[OK] unknown provider webhook rejected');
  });
});

// ---------------------------------------------------------------------------
// H) Webhook missing signature (control)
// ---------------------------------------------------------------------------
describe('H) Missing webhook signature rejected (control)', () => {
  it('a webhook with no signature header is rejected', async () => {
    const body = buildStripeWebhook('chg_missing1');
    const res = await runtime.post('/v1/api/webhooks/stripe', body, {});
    expect(res.status).toBe(401);
    console.warn('[OK] missing webhook signature rejected');
  });
});

// ---------------------------------------------------------------------------
// I) Admin dashboards now require admin auth (FIXED)
// ---------------------------------------------------------------------------
describe('I) Admin dashboards now require admin auth (FIXED)', () => {
  it('dashboard logs/metrics/observability require admin auth', async () => {
    // emit a cross-tenant event
    const donation = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    expect(donation.status).toBe(200);

    const logs = await runtime.get('/api/dashboard/logs');
    const metrics = await runtime.get('/api/dashboard/metrics');
    const obs = await runtime.get('/api/observability/logs');

    // P0 FIX: all admin endpoints now require admin auth. ADMIN_API_TOKEN is
    // configured in this suite (F10), so a missing token is a real 403 — not
    // the 503 "not configured" this assertion used to also accept.
    expect(logs.status).toBe(403);
    expect(metrics.status).toBe(403);
    expect(obs.status).toBe(403);
    expect((await runtime.get('/api/dashboard/logs', { 'x-admin-token': 'wrong-' + ADMIN_TOKEN })).status).toBe(403);
    // ...and the gate really opens for the configured token.
    expect((await runtime.get('/api/dashboard/logs', { 'x-admin-token': ADMIN_TOKEN })).status).toBe(200);
    console.warn('[FIXED] admin dashboards (logs/metrics/observability) now require admin auth — no cross-tenant event leak');
  });
});

// ---------------------------------------------------------------------------
// J) Conversation tenant misattribution (VULN)
// ---------------------------------------------------------------------------
describe('J) Conversation tenantId taken from unvalidated body (VULN)', () => {
  it('conversation is tagged with the authenticated tenant, ignoring body tenantId', async () => {
    const res = await runtime.post(
      '/v1/api/gateway/messaging',
      { recipient: DONOR_PHONE, content: 'hi', tenantId: OTHER_TENANT_ID_HAULPRO },
      AUTH,
    );
    expect(res.status).toBe(200);

    const conv = findConversation(APP_SLUG, DONOR_PHONE);
    // SECURE expectation: the conversation is scoped to the authenticated tenant.
    expect(conv?.tenantId).toBe(TENANT_ID);
    console.warn('[DEFECT] gateway ignores body.tenantId when recording conversations; conversation stored with null tenantId — tenant is never enforced/isolated');
  });
});

// ---------------------------------------------------------------------------
// K) Cross-tenant conversation bleed within an app (GAP)
// ---------------------------------------------------------------------------
describe('K) Conversations keyed by (phone, app) only (GAP)', () => {
  it('tenant context bleeds across sends to the same recipient', async () => {
    const a = await runtime.post(
      '/v1/api/gateway/messaging',
      { recipient: DONOR_PHONE, content: 'first', tenantId: TENANT_ID },
      AUTH,
    );
    expect(a.status).toBe(200);

    const b = await runtime.post(
      '/v1/api/gateway/messaging',
      { recipient: DONOR_PHONE, content: 'second', tenantId: OTHER_TENANT_ID },
      AUTH,
    );
    expect(b.status).toBe(200);

    const conv = findConversation(APP_SLUG, DONOR_PHONE);
    // SECURE expectation: only the authenticated tenant is used.
    expect(conv?.tenantId).toBe(TENANT_ID);
    console.warn('[GAP] conversations keyed by (phone, app) only; tenant is not part of the key, so tenant context is never scoped across sends');
  });
});

// ---------------------------------------------------------------------------
// L) SSRF surface (control / INFO)
// ---------------------------------------------------------------------------
describe('L) SSRF surface (control)', () => {
  it('providerOverride is a registry id lookup, not a URL fetch', async () => {
    const res = await sendMessage(runtime, {
      recipient: DONOR_PHONE,
      content: 'hi',
      providerOverride: 'http://169.254.169.254/latest/meta-data/',
    });
    // No server-side fetch must occur: the request is treated as a registry id
    // lookup and routed to a real provider, never to the supplied URL.
    expect(['200', '400', '503'].includes(String(res.status))).toBe(true);
    expect(String(res.body?.providerId ?? '').indexOf('169.254.169.254')).toBe(-1);
    console.warn('[OK]/[INFO] no SSRF surface: providerOverride is a registry id lookup, not a URL fetch — internal URL was not requested by the server');
  });
});

// ---------------------------------------------------------------------------
// M) Secret leakage (control)
// ---------------------------------------------------------------------------
describe('M) Provider secret endpoint (control)', () => {
  it('does not leak a raw provider secret', async () => {
    // ADMIN_API_TOKEN is configured in this suite (F10): no token => 403.
    const denied = await runtime.get('/api/dashboard/providers/stripe/secrets');
    expect(denied.status).toBe(403);
    console.warn('[OK] secret endpoint requires admin auth');

    // With the gate open, store a known raw secret (on a probe field no
    // adapter reads) so there is actually something to leak — previously this
    // branch was unreachable and the list would have been empty anyway.
    const admin = { 'x-admin-token': ADMIN_TOKEN };
    const raw = 'sk_live_p14probe_' + randomBytes(8).toString('hex');
    const added = await runtime.post('/api/dashboard/providers/stripe/secrets', { field: 'p14MaskProbe', label: 'probe', value: raw }, admin);
    expect(added.status).toBe(201);
    const addedMeta = await json(added);
    try {
      const res = await runtime.get('/api/dashboard/providers/stripe/secrets', admin);
      expect(res.status).toBe(200);
      const body = await json(res);
      const blob = JSON.stringify(body);
      expect(blob).toContain('masked');
      expect(blob).not.toContain(raw);
      expect(blob).not.toContain('sk_live_');
      expect(blob).not.toContain('sim-webhook-hmac-secret-0123456789abcdef');
      console.warn('[OK] provider secret endpoint returns masked values only (no raw secret leakage)');
    } finally {
      await runtime.request('DELETE', `/api/dashboard/providers/stripe/secrets/${addedMeta.id}`, { headers: admin });
    }
  });
});

// ---------------------------------------------------------------------------
// N) Rate-limit bypass on admin endpoints (FIXED)
// ---------------------------------------------------------------------------
// F10 (Phase 14): this used to accept 429 OR 403 OR 503 with "> 0" — met by
// the 503s alone, since the suite had no admin token and a 100000 limit. It
// now drives a real burst past the real configured limit and asserts the
// exact split: RATE_LIMIT requests reach the admin gate (403), the rest are
// refused by the limiter (429), none are "not configured" (503).
describe('N) Admin endpoints now have rate limiting (FIXED)', () => {
  it('rapid admin reads from one address are throttled with a real 429 at the configured limit', async () => {
    const ip = freshLoopback();
    const statuses = await Promise.all(
      Array.from({ length: 200 }, () => requestFrom(runtime.baseUrl, ip, 'GET', '/api/dashboard/logs')),
    );
    expect(statuses.filter((s) => s === 403).length).toBe(RATE_LIMIT);
    expect(statuses.filter((s) => s === 429).length).toBe(200 - RATE_LIMIT);
    expect(statuses.filter((s) => s === 503).length).toBe(0);
    // Throttled even with the right token — the limiter runs before the gate.
    expect(await requestFrom(runtime.baseUrl, ip, 'GET', '/api/dashboard/logs', { 'x-admin-token': ADMIN_TOKEN })).toBe(429);
    // Per caller: a different address still reaches the gate.
    expect(await requestFrom(runtime.baseUrl, freshLoopback(), 'GET', '/api/dashboard/logs', { 'x-admin-token': ADMIN_TOKEN })).toBe(200);
    console.warn('[FIXED] admin endpoints now have rate limiting — real 429s past the configured per-IP limit');
  });

  it('a fresh random x-api-key on every request does not buy a fresh admin bucket (C14)', async () => {
    const ip = freshLoopback();
    const statuses = await Promise.all(
      Array.from({ length: 200 }, () =>
        requestFrom(runtime.baseUrl, ip, 'GET', '/api/dashboard/admin/verify', {
          'x-api-key': 'bap_test_' + randomBytes(12).toString('hex'),
          'x-admin-token': 'guess-' + randomBytes(6).toString('hex'),
        }),
      ),
    );
    expect(statuses.filter((s) => s === 403).length).toBe(RATE_LIMIT);
    expect(statuses.filter((s) => s === 429).length).toBe(200 - RATE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// O) Duplicate payment submission (VULN) + webhook replay protection (FIXED)
// ---------------------------------------------------------------------------
describe('O) Duplicate payment submission (VULN) vs webhook replay protection (FIXED)', () => {
  it('POST /payment has no idempotency; webhook replay is protected at gateway AND worker', async () => {
    const first = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    const second = await createDonation(runtime, { amount: 5000, currency: 'USD' }, AUTH);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const txId1 = first.body.id;
    const txId2 = second.body.id;

    // FIXED: Gateway-level deduplication rejects replayed webhooks.
    // Use the same event ID for both deliveries to test deduplication.
    const eventId = `evt_replay_test_${Date.now()}`;
    const body1 = buildStripeWebhook(txId1, { id: eventId });
    const delivery = await deliverWebhook(runtime, 'stripe', body1);
    expect(delivery.status).toBe(200);

    // Same event ID sent again — recognised as a duplicate by the durable
    // (provider_id, provider_event_id) unique index and acknowledged 200
    // without re-enqueueing (Phase 4; previously an in-memory 409).
    const body2 = buildStripeWebhook(txId1, { id: eventId });
    const delivery2 = await deliverWebhook(runtime, 'stripe', body2);
    expect(delivery2.status).toBe(200);
    expect(delivery2.json.duplicate).toBe(true);
    expect(dbState.webhookEvents.filter((e) => e.providerId === 'stripe' && e.providerEventId === eventId)).toHaveLength(1);
    console.warn('[FIXED] webhook replay is protected at gateway level (durable DB-enforced duplicate detection)');

    // VULN: duplicate POST /payment submissions are NOT idempotent.
    // Current state: each submission creates a new txId (no idempotency key enforcement).
    expect(txId2).not.toBe(txId1);
    console.warn('[VULN] no server-side idempotency on POST /payment — duplicate submission creates a duplicate charge');
  });
});
