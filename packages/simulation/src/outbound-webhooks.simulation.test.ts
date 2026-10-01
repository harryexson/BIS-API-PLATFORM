import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { clearDb, dbState, installDatabaseMock, seedReachChurch } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including the outbound webhook dispatch wired up
// in this pass — is the REAL code (services/api-gateway/src/app.ts,
// packages/events/src/webhook-delivery.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, createDonation, waitFor, type SimRuntime } from './harness';

console.warn(`\n[simulation] Outbound platform webhooks (register + real signed delivery)\n`);

let runtime: SimRuntime;

const HEADERS = {
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': 'ten_reach_church',
};

const OTHER_APP_HEADERS = {
  authorization: 'Bearer bap_test_haulpro_0001',
  'x-tenant-id': 'ten_haulpro',
};

let realFetch: typeof fetch;
let webhookCalls: { url: string; init: RequestInit }[];

beforeAll(async () => {
  realFetch = globalThis.fetch;
  // Required for encryptSecret/decryptSecret (webhook_endpoints' signing
  // secret is stored encrypted, same as provider secrets) — without it,
  // registration 400s with the same "not set" error a real deployment
  // would hit.
  process.env.SECRET_ENCRYPTION_KEY = 'sim-secret-encryption-key-0123456789';
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

beforeEach(() => {
  clearDb();
  seedReachChurch();
  webhookCalls = [];
  // Pass real requests to the gateway's own ephemeral test server through
  // untouched; only intercept calls that look like an outbound delivery to
  // a developer's registered callback URL.
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.startsWith(runtime.baseUrl)) {
      return realFetch(url as any, init);
    }
    webhookCalls.push({ url: href, init: init ?? {} });
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /v1/api/gateway/webhooks', () => {
  it('registers an endpoint and returns a one-time secret', async () => {
    const res = await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.url).toBe('https://developer.example.com/hook');
    expect(body.events).toEqual(['*']);
    expect(body.active).toBe(true);
    expect(typeof body.secret).toBe('string');
    expect(body.secret).toMatch(/^whsec_/);
  });

  it('400s on a non-URL, and rejects http in production-like config left to default (https required)', async () => {
    const res = await runtime.post('/v1/api/gateway/webhooks', { url: 'not-a-url' }, HEADERS);
    expect(res.status).toBe(400);
  });

  it('GET lists endpoints for the authenticated app without exposing the secret again', async () => {
    await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);

    const res = await runtime.get('/v1/api/gateway/webhooks', HEADERS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.endpoints[0].url).toBe('https://developer.example.com/hook');
    expect(body.endpoints[0].secret).toBeUndefined();
  });

  it("does not list another application's endpoints", async () => {
    await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);

    const res = await runtime.get('/v1/api/gateway/webhooks', OTHER_APP_HEADERS);
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it("DELETE 404s against another application's endpoint id (ownership enforced)", async () => {
    const create = await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);
    const { id } = await create.json();

    const res = await runtime.request('DELETE', `/v1/api/gateway/webhooks/${id}`, { headers: OTHER_APP_HEADERS });
    expect(res.status).toBe(404);
    expect(dbState.webhookEndpoints.find((w) => w.id === id)).toBeDefined();
  });

  it('DELETE removes the endpoint for its own application', async () => {
    const create = await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);
    const { id } = await create.json();

    const res = await runtime.request('DELETE', `/v1/api/gateway/webhooks/${id}`, { headers: HEADERS });
    expect(res.status).toBe(204);
    expect(dbState.webhookEndpoints.find((w) => w.id === id)).toBeUndefined();
  });
});

describe('end-to-end delivery: a registered endpoint receives a real, correctly signed TransactionEvent', () => {
  it('delivers a payment event with a valid X-Webhook-Signature', async () => {
    const create = await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);
    const { secret } = await create.json();

    const donation = await createDonation(runtime, { amount: 25, providerOverride: 'stripe' });
    expect(donation.status).toBe(200);

    await waitFor(() => runtime.gatewayWebhookDelivery.getPending().length > 0, {
      label: 'donation event enqueued for delivery',
      timeoutMs: 2000,
    });
    await runtime.gatewayWebhookDelivery.flush();

    await waitFor(() => webhookCalls.length > 0, { label: 'webhook POST delivered', timeoutMs: 2000 });

    expect(webhookCalls).toHaveLength(1);
    const [call] = webhookCalls;
    expect(call.url).toBe('https://developer.example.com/hook');

    const rawBody = call.init.body as string;
    const delivered = JSON.parse(rawBody);
    expect(delivered.id).toBe(donation.txId);
    expect(delivered.category).toBe('payment');
    expect(delivered.status).toBe('success');

    const headers = call.init.headers as Record<string, string>;
    const expectedSignature = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    expect(headers['X-Webhook-Signature']).toBe(expectedSignature);
    expect(headers['X-Webhook-Id']).toBeDefined();
  });

  it('does not deliver to an endpoint subscribed only to a different event category', async () => {
    await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook', events: ['messaging'] }, HEADERS);

    await createDonation(runtime, { amount: 10, providerOverride: 'stripe' });

    // Give any (incorrect) dispatch a moment to happen, then confirm nothing did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.gatewayWebhookDelivery.flush();
    expect(webhookCalls).toHaveLength(0);
  });

  it("does not deliver to another application's endpoint", async () => {
    await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, OTHER_APP_HEADERS);

    await createDonation(runtime, { amount: 10, providerOverride: 'stripe' });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.gatewayWebhookDelivery.flush();
    expect(webhookCalls).toHaveLength(0);
  });

  it('an inactive-by-deletion endpoint receives nothing after removal', async () => {
    const create = await runtime.post('/v1/api/gateway/webhooks', { url: 'https://developer.example.com/hook' }, HEADERS);
    const { id } = await create.json();
    await runtime.request('DELETE', `/v1/api/gateway/webhooks/${id}`, { headers: HEADERS });

    await createDonation(runtime, { amount: 10, providerOverride: 'stripe' });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await runtime.gatewayWebhookDelivery.flush();
    expect(webhookCalls).toHaveLength(0);
  });
});
