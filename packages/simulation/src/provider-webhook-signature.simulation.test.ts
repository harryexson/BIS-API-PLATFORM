import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { dbState, clearDb, seedReachChurch, installDatabaseMock } from './db';

vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, signWebhook, waitFor, stopWorker, WEBHOOK_SECRET, type SimRuntime, type WorkerHandle } from './harness';

/**
 * Phase 26 — gap register E10: the 7 native provider webhook verifiers
 * (stripe, nmi, flutterwave, paychangu, airwallex, square, whatsapp) are
 * wired into the REAL gateway route, POST /v1/api/webhooks/:provider, over
 * real HTTP. Before this phase `verifyProviderWebhookSignature` was called
 * nowhere outside the adapters' own unit tests: the route checked only the
 * platform's shared WEBHOOK_HMAC_SECRET (x-webhook-signature), so nothing
 * ever tied a webhook to the provider that supposedly sent it.
 *
 * Every request below is signed exactly the way that provider documents
 * (each adapter's own doc comment cites the source) over the RAW bytes sent.
 * No provider is contacted.
 */

let runtime: SimRuntime;
const restorers: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

afterEach(() => {
  while (restorers.length) restorers.pop()!();
});

function configure(providerId: string, secrets: Record<string, string>) {
  const provider = runtime.registry.getProvider(providerId)!;
  provider.setSecrets(secrets);
  restorers.push(() => provider.setSecrets({}));
}

async function send(providerId: string, rawBody: string, headers: Record<string, string>) {
  const res = await runtime.postText(`/v1/api/webhooks/${providerId}`, rawBody, headers);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const rowsFor = (providerId: string, providerEventId: string) =>
  dbState.webhookEvents.filter((e) => e.providerId === providerId && e.providerEventId === providerEventId);

const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data, 'utf8').digest('hex');

function stripeSignature(secret: string, rawBody: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

interface NativeCase {
  id: string;
  secrets: Record<string, string>;
  /** A body in this provider's shape that carries an extractable event id. */
  body(eventId: string): string;
  /** The provider's real signature headers for `rawBody`. */
  sign(rawBody: string): Record<string, string>;
}

const STRIPE_SECRET = 'whsec_phase26_test';
const NATIVE_CASES: NativeCase[] = [
  {
    id: 'stripe',
    secrets: { webhook_secret: STRIPE_SECRET },
    body: (id) => JSON.stringify({ id, object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_p26', object: 'payment_intent' } } }),
    sign: (raw) => ({ 'stripe-signature': stripeSignature(STRIPE_SECRET, raw) }),
  },
  {
    // NMI's natively-signed body carries `event_id`, not `id`.
    id: 'nmi',
    secrets: { webhook_secret: 'nmi_signing_key' },
    body: (id) => JSON.stringify({ event_id: id, event_type: 'transaction.sale.success', event_body: { transaction_id: '9001' } }),
    sign: (raw) => ({ 'webhook-signature': `t=nonce123,s=${hmacHex('nmi_signing_key', `nonce123.${raw}`)}` }),
  },
  {
    id: 'flutterwave',
    secrets: { webhook_secret: 'flw-dashboard-secret-hash' },
    body: (id) => JSON.stringify({ id, event: 'charge.completed', data: { id: 777, status: 'successful' } }),
    sign: () => ({ 'verif-hash': 'flw-dashboard-secret-hash' }),
  },
  {
    id: 'paychangu',
    secrets: { webhook_secret: 'pc_web_secret' },
    body: (id) => JSON.stringify({ id, event_type: 'api.charge.payment', status: 'success' }),
    sign: (raw) => ({ signature: hmacHex('pc_web_secret', raw) }),
  },
  {
    id: 'airwallex',
    secrets: { client_id: '', api_key: '', webhook_secret: 'awx_notification_secret' },
    body: (id) => JSON.stringify({ id, name: 'payment_intent.succeeded', data: { object: { id: 'int_1' } } }),
    sign: (raw) => {
      const ts = String(Date.now());
      return { 'x-timestamp': ts, 'x-signature': hmacHex('awx_notification_secret', `${ts}${raw}`) };
    },
  },
  {
    // Square's natively-signed body carries `event_id`, not `id`.
    id: 'square',
    secrets: { webhook_signature_key: 'sq_sig_key', webhook_notification_url: 'https://api.bis.example/v1/api/webhooks/square' },
    body: (id) => JSON.stringify({ merchant_id: 'M1', type: 'payment.updated', event_id: id, data: { type: 'payment', id: 'sq_p1' } }),
    sign: (raw) => ({
      'x-square-hmacsha256-signature': createHmac('sha256', 'sq_sig_key')
        .update(`https://api.bis.example/v1/api/webhooks/square${raw}`, 'utf8')
        .digest('base64'),
    }),
  },
  {
    id: 'whatsapp',
    secrets: { app_secret: 'meta_app_secret' },
    body: (id) => JSON.stringify({ id, object: 'whatsapp_business_account', entry: [] }),
    sign: (raw) => ({ 'x-hub-signature-256': `sha256=${hmacHex('meta_app_secret', raw)}` }),
  },
];

describe("Phase 26 — E10: each provider's own webhook signature is verified on the real gateway route", () => {
  for (const c of NATIVE_CASES) {
    describe(c.id, () => {
      it('a request signed with the provider\'s REAL scheme (and no platform signature at all) is accepted, recorded and attested for the worker', async () => {
        configure(c.id, c.secrets);
        const eventId = `evt_p26_native_${c.id}`;
        const raw = c.body(eventId);

        const res = await send(c.id, raw, c.sign(raw));

        expect(res.status).toBe(200);
        expect(res.json.verificationMethod).toBe('native');
        const rows = rowsFor(c.id, eventId);
        expect(rows).toHaveLength(1);
        expect(rows[0].rawBody).toBe(raw);
        // The job the worker consumes is attested with the platform secret
        // over the same raw bytes — issued by the gateway only after the
        // provider's own signature passed.
        expect(rows[0].signature).toBe(signWebhook(raw, WEBHOOK_SECRET));
      });

      it('once the provider\'s native secret is configured, a VALID platform signature can no longer bypass it (401, nothing stored)', async () => {
        configure(c.id, c.secrets);
        const eventId = `evt_p26_bypass_${c.id}`;
        const raw = c.body(eventId);

        const res = await send(c.id, raw, { 'x-webhook-signature': signWebhook(raw) });

        expect(res.status).toBe(401);
        expect(res.json.error).toBe('Invalid provider webhook signature');
        expect(rowsFor(c.id, eventId)).toHaveLength(0);
      });

      it('a body altered after the provider signed it is rejected (401, nothing stored)', async () => {
        configure(c.id, c.secrets);
        const eventId = `evt_p26_tamper_${c.id}`;
        const raw = c.body(eventId);
        const headers = c.sign(raw);
        const tampered = raw.replace(eventId, `${eventId}_x`);

        const res = await send(c.id, tampered, headers);

        if (c.id === 'flutterwave') {
          // Flutterwave's documented `verif-hash` is a static shared value
          // echoed on every delivery, NOT a signature over the body — it
          // cannot detect tampering. Pre-existing, disclosed limitation of
          // the provider's scheme (gap register E10 "additional findings").
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(401);
          expect(rowsFor(c.id, `${eventId}_x`)).toHaveLength(0);
        }
      });
    });
  }

  it('Stripe: verification runs over the exact RAW bytes — a body whose whitespace/key order differs from JSON.stringify(req.body) still verifies', async () => {
    configure('stripe', { webhook_secret: STRIPE_SECRET });
    const raw = '{ "type" : "payment_intent.succeeded",\n  "id": "evt_p26_rawbytes", "data": {"object": {"id": "pi_raw"}} }';
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);

    const res = await send('stripe', raw, { 'stripe-signature': stripeSignature(STRIPE_SECRET, raw) });

    expect(res.status).toBe(200);
    expect(rowsFor('stripe', 'evt_p26_rawbytes')[0].rawBody).toBe(raw);
  });

  it('Stripe: a correctly-signed but replayed delivery older than 5 minutes is rejected', async () => {
    configure('stripe', { webhook_secret: STRIPE_SECRET });
    const raw = JSON.stringify({ id: 'evt_p26_stale', type: 'charge.succeeded', data: { object: { id: 'ch_stale' } } });
    const t = Math.floor(Date.now() / 1000) - 10 * 60;

    const res = await send('stripe', raw, { 'stripe-signature': stripeSignature(STRIPE_SECRET, raw, t) });

    expect(res.status).toBe(401);
    expect(rowsFor('stripe', 'evt_p26_stale')).toHaveLength(0);
  });

  it('Airwallex: a correctly-signed delivery with a stale x-timestamp is rejected (new replay window)', async () => {
    configure('airwallex', { webhook_secret: 'awx_notification_secret' });
    const raw = JSON.stringify({ id: 'evt_p26_awx_stale', name: 'payment_intent.succeeded' });
    const ts = String(Date.now() - 10 * 60_000);

    const res = await send('airwallex', raw, { 'x-timestamp': ts, 'x-signature': hmacHex('awx_notification_secret', `${ts}${raw}`) });

    expect(res.status).toBe(401);
    expect(rowsFor('airwallex', 'evt_p26_awx_stale')).toHaveLength(0);
  });

  it('a provider with no native scheme (PawaPay) — or a native scheme with no secret configured — keeps the platform signature path unchanged', async () => {
    const raw = JSON.stringify({ id: 'evt_p26_pawapay', depositId: 'd1', status: 'COMPLETED' });
    expect((await send('pawapay', raw, {})).status).toBe(401);
    const ok = await send('pawapay', raw, { 'x-webhook-signature': signWebhook(raw) });
    expect(ok.status).toBe(200);
    expect(ok.json.verificationMethod).toBe('platform');

    // Stripe with NO webhook secret configured: native verifier returns null → platform path.
    const sraw = JSON.stringify({ id: 'evt_p26_stripe_platform', type: 'charge.succeeded', data: { object: { id: 'ch_pl' } } });
    const s = await send('stripe', sraw, { 'x-webhook-signature': signWebhook(sraw) });
    expect(s.status).toBe(200);
    expect(s.json.verificationMethod).toBe('platform');
  });

  describe('end to end: the worker processes a natively-verified webhook', () => {
    let worker: WorkerHandle | undefined;
    afterAll(async () => {
      if (worker) await stopWorker(worker);
    });

    it('a Stripe-signed webhook with no platform signature reaches status processed (the worker accepts the gateway attestation)', async () => {
      configure('stripe', { webhook_secret: STRIPE_SECRET });
      const raw = JSON.stringify({ id: 'evt_p26_e2e', object: 'event', type: 'charge.succeeded', data: { object: { id: 'ch_p26_e2e', object: 'charge' } } });

      const res = await send('stripe', raw, { 'stripe-signature': stripeSignature(STRIPE_SECRET, raw) });
      expect(res.status).toBe(200);
      const eventId: string = res.json.webhookEventId;

      worker = await runtime.makeWorker({ store: runtime.gatewayStore, keys: runtime.gatewayKeys });
      await waitFor(() => dbState.webhookEvents.find((e) => e.id === eventId)?.status === 'processed', {
        label: 'natively-verified webhook processed by the worker',
      });
      const consumers = dbState.webhookEventConsumers.filter((c) => c.webhookEventId === eventId);
      expect(consumers.length).toBeGreaterThan(0);
      expect(consumers.every((c) => c.status === 'processed')).toBe(true);
    }, 20_000);
  });
});
