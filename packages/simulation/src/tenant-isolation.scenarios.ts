import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { logger } from '@company/observability';
import {
  buildStripeWebhook,
  deliverWebhook,
  sleep,
  waitFor,
  stopWorker,
  type SimRuntime,
  type WorkerHandle,
} from './harness';

/**
 * Phase 7 — multi-tenant security as a hard boundary (gap register C4,
 * GW-1.1/1.2/1.4/1.5/1.6, F3.2, F3.8, F14 item 6).
 *
 * One adversarial suite, run black-box through the REAL gateway routes
 * (HTTP), against two database back-ends:
 *   - tenant-isolation.postgres.integration.test.ts — the real repositories
 *     on a real, migrated-from-zero PostgreSQL (the authoritative proof);
 *   - tenant-isolation.simulation.test.ts — the in-memory database double,
 *     so the same assertions also run in a plain `npx vitest run`.
 *
 * The world: ONE shared application (the realistic "many churches under one
 * Reach Church registration / many hosts under one STAYSCAPE registration"
 * model) with TWO linked tenants A and B, each with its own supplier; a
 * second, independent application with its own tenant and supplier; and a
 * tenant that exists but is not linked to the shared application.
 *
 * For every boundary the suite proves:
 *   1. tenant A's own request succeeds;
 *   2. tenant B — a valid API key for the SAME application, a DIFFERENT
 *      (validly linked) x-tenant-id — is denied tenant A's resource. Reads,
 *      refunds and deletes of another tenant's resource answer 404, exactly
 *      like a resource that does not exist: a 403 would confirm to tenant B
 *      that the id it guessed or leaked is real (an existence oracle). A
 *      request that names a tenant/supplier it does not OWN in its auth
 *      headers is a 403 — there the caller is told its credentials do not
 *      grant that scope, which reveals nothing it did not already claim;
 *   3. an identity override attempted through the BODY (tenantId,
 *      applicationId, supplierId…) never wins over the authenticated context.
 */

export interface IsolationSupplier {
  id: string;
  slug: string;
}

export interface IsolationWorld {
  runtime: SimRuntime;
  /** The shared application's slug and a valid API key for it. */
  appSlug: string;
  apiKey: string;
  /** Two tenants, BOTH linked to the shared application. */
  tenantA: string;
  tenantB: string;
  /** A tenant that exists but is NOT linked to the shared application. */
  unlinkedTenant: string;
  /** A second, independent application. */
  otherApp: { slug: string; apiKey: string; tenantId: string };
  /** ADMIN_API_TOKEN the gateway was booted with. */
  adminToken: string;
  supplierA: IsolationSupplier; // owned by (shared app, tenant A)
  supplierB: IsolationSupplier; // owned by (shared app, tenant B)
  otherAppSupplier: IsolationSupplier; // owned by (other app, its tenant)
  /** The durable webhook_events row for a provider event id (attribution check). */
  webhookEventRow(providerId: string, providerEventId: string): Promise<{ appId: string | null; tenantId: string | null } | undefined>;
  /** The platform's transactions row for a payment transaction id. */
  transactionRow(paymentTransactionId: string): Promise<{ appId: string; tenantId: string; metadata: unknown } | undefined>;
  /** Start a worker attached to the gateway's real queue. */
  startWorker(): Promise<WorkerHandle>;
}

interface Captured {
  path: string;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

async function startCaptureServer(): Promise<{ url: string; captured: Captured[]; close(): Promise<void> }> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep raw
      }
      captured.push({ path: req.url ?? '', body, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () =>
      new Promise<void>((resolve) => {
        (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function json(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

export function registerTenantIsolationScenarios(getWorld: () => IsolationWorld): void {
  let w: IsolationWorld;
  let capture: Awaited<ReturnType<typeof startCaptureServer>>;

  const as = (tenantId: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${w.apiKey}`,
    'x-tenant-id': tenantId,
    ...extra,
  });
  const A = (extra: Record<string, string> = {}) => as(w.tenantA, extra);
  const B = (extra: Record<string, string> = {}) => as(w.tenantB, extra);
  const OTHER_APP = () => ({ authorization: `Bearer ${w.otherApp.apiKey}`, 'x-tenant-id': w.otherApp.tenantId });

  async function pay(headers: Record<string, string>, body: Record<string, unknown> = {}) {
    const res = await w.runtime.post(
      '/v1/api/gateway/payment',
      { amount: 25, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', ...body },
      headers,
    );
    return { status: res.status, body: await json(res) };
  }

  async function del(path: string, headers: Record<string, string>, body?: unknown) {
    return w.runtime.request('DELETE', path, {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** Flush the gateway's real outbound-webhook delivery until `pred` holds over what was captured. */
  async function deliverUntil(pred: (c: Captured[]) => boolean, label: string) {
    await waitFor(
      async () => {
        await w.runtime.gatewayWebhookDelivery.flush();
        return pred(capture.captured);
      },
      { timeoutMs: 10_000, everyMs: 50, label },
    );
  }

  /** Give any (wrongly) dispatched delivery every chance to arrive before asserting it did not. */
  async function settleDeliveries() {
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      await w.runtime.gatewayWebhookDelivery.flush();
    }
  }

  async function registerEndpoint(headers: Record<string, string>, path: string, body: Record<string, unknown> = {}) {
    const res = await w.runtime.post('/v1/api/gateway/webhooks', { url: `${capture.url}${path}`, ...body }, headers);
    return { status: res.status, body: await json(res) };
  }

  beforeAll(async () => {
    w = getWorld();
    capture = await startCaptureServer();
  });

  afterAll(async () => {
    await capture?.close();
  });

  // -------------------------------------------------------------------------
  describe('identity comes only from the authenticated context', () => {
    it('a valid key for the shared app + a tenant of ANOTHER application is a 403', async () => {
      const r = await pay(as(w.otherApp.tenantId));
      expect(r.status).toBe(403);
    });

    it('a valid key for the shared app + an existing but unlinked tenant is a 403', async () => {
      const r = await pay(as(w.unlinkedTenant));
      expect(r.status).toBe(403);
    });

    it('application identity: a body appId / applicationId naming another application is ignored — the API key decides', async () => {
      const r = await pay(A(), { appId: w.otherApp.slug, applicationId: w.otherApp.slug });
      expect(r.status).toBe(200);
      expect(r.body.appId).toBe(w.appSlug);
      expect(r.body.tenantId).toBe(w.tenantA);
    });

    it('tenant identity: body tenantId / tenant_id naming tenant B never wins over the authenticated tenant A', async () => {
      const r = await pay(A(), { tenantId: w.tenantB, tenant_id: w.tenantB });
      expect(r.status).toBe(200);
      expect(r.body.tenantId).toBe(w.tenantA);
      const row = await w.transactionRow(r.body.paymentTransactionId);
      expect(row?.appId).toBe(w.appSlug);
      expect(row?.tenantId).toBe(w.tenantA);
    });

    it("application A's key presented with application B's tenant is refused, and B's key never acts for A", async () => {
      // Shared-app key + other app's tenant header → 403 (no cross-app tenant borrowing).
      expect((await pay(as(w.otherApp.tenantId))).status).toBe(403);
      // Other app's key + shared app's tenant header → 403.
      const r = await w.runtime.post(
        '/v1/api/gateway/payment',
        { amount: 5, currency: 'USD', providerOverride: 'stripe', appId: w.appSlug },
        { authorization: `Bearer ${w.otherApp.apiKey}`, 'x-tenant-id': w.tenantA },
      );
      expect(r.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe('transaction status read', () => {
    it("tenant A reads its own payment; tenant B (same app) and another app get 404; a query/body tenant override does not help", async () => {
      const p = await pay(A());
      expect(p.status).toBe(200);
      const id = p.body.id as string;

      const own = await w.runtime.get(`/v1/api/gateway/transaction/${id}`, A());
      expect(own.status).toBe(200);
      expect((await json(own)).id).toBe(id);

      expect((await w.runtime.get(`/v1/api/gateway/transaction/${id}`, B())).status).toBe(404);
      expect((await w.runtime.get(`/v1/api/gateway/transaction/${id}?tenantId=${encodeURIComponent(w.tenantA)}`, B())).status).toBe(404);
      expect((await w.runtime.get(`/v1/api/gateway/transaction/${id}`, OTHER_APP())).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('refund', () => {
    it("tenant B (same app) cannot refund tenant A's payment — not even with body tenantId/applicationId overrides; tenant A can", async () => {
      const p = await pay(A(), { amount: 40 });
      expect(p.status).toBe(200);
      const paymentId = p.body.id as string;

      const asB = await w.runtime.post('/refunds', { payment_id: paymentId }, B());
      expect(asB.status).toBe(404);

      const asBWithOverride = await w.runtime.post(
        '/refunds',
        { payment_id: paymentId, tenantId: w.tenantA, tenant_id: w.tenantA, applicationId: w.appSlug, appId: w.appSlug },
        B(),
      );
      expect(asBWithOverride.status).toBe(404);

      const asOtherApp = await w.runtime.post('/refunds', { payment_id: paymentId }, OTHER_APP());
      expect(asOtherApp.status).toBe(404);

      const asA = await w.runtime.post('/refunds', { payment_id: paymentId, reason: 'requested_by_customer' }, A());
      expect(asA.status).toBe(201);
      expect((await json(asA)).payment_id).toBe(paymentId);
    });
  });

  // -------------------------------------------------------------------------
  describe('webhook endpoints (list / delete / create)', () => {
    it('each tenant lists only its own endpoints', async () => {
      const a = await registerEndpoint(A(), '/list-a');
      const b = await registerEndpoint(B(), '/list-b');
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const listA = await json(await w.runtime.get('/v1/api/gateway/webhooks', A()));
      const listB = await json(await w.runtime.get('/v1/api/gateway/webhooks', B()));
      const idsA = listA.endpoints.map((e: any) => e.id);
      const idsB = listB.endpoints.map((e: any) => e.id);
      expect(idsA).toContain(a.body.id);
      expect(idsA).not.toContain(b.body.id);
      expect(idsB).toContain(b.body.id);
      expect(idsB).not.toContain(a.body.id);
      expect(listA.endpoints.every((e: any) => !String(e.url).includes('/list-b'))).toBe(true);
    });

    it("tenant B cannot delete tenant A's endpoint (404, endpoint survives), even with a body tenantId override; tenant A can", async () => {
      const a = await registerEndpoint(A(), '/del-a');
      expect(a.status).toBe(201);

      expect((await del(`/v1/api/gateway/webhooks/${a.body.id}`, B())).status).toBe(404);
      expect((await del(`/v1/api/gateway/webhooks/${a.body.id}`, B(), { tenantId: w.tenantA })).status).toBe(404);
      expect((await del(`/v1/api/gateway/webhooks/${a.body.id}`, OTHER_APP())).status).toBe(404);

      const stillThere = await json(await w.runtime.get('/v1/api/gateway/webhooks', A()));
      expect(stillThere.endpoints.map((e: any) => e.id)).toContain(a.body.id);

      expect((await del(`/v1/api/gateway/webhooks/${a.body.id}`, A())).status).toBe(204);
      const gone = await json(await w.runtime.get('/v1/api/gateway/webhooks', A()));
      expect(gone.endpoints.map((e: any) => e.id)).not.toContain(a.body.id);
    });

    it('create: a body tenantId naming tenant A, sent as tenant B, registers the endpoint for tenant B only', async () => {
      const r = await registerEndpoint(B(), '/create-override', { tenantId: w.tenantA });
      expect(r.status).toBe(201);
      const listA = await json(await w.runtime.get('/v1/api/gateway/webhooks', A()));
      const listB = await json(await w.runtime.get('/v1/api/gateway/webhooks', B()));
      expect(listA.endpoints.map((e: any) => e.id)).not.toContain(r.body.id);
      expect(listB.endpoints.map((e: any) => e.id)).toContain(r.body.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('messaging profiles (list / create)', () => {
    it('each tenant lists only its own profiles; a body tenantId override on create is ignored', async () => {
      const sender = (n: number) => `+1555${String(Date.now() % 1_000_000).padStart(6, '0')}${n}`;
      const a = await w.runtime.post(
        '/v1/api/gateway/messaging-profiles',
        { country: 'US', senderType: 'phone', sender: sender(1), provider: 'signalhouse' },
        A(),
      );
      const bOverride = await w.runtime.post(
        '/v1/api/gateway/messaging-profiles',
        { country: 'US', senderType: 'phone', sender: sender(2), provider: 'signalhouse', tenantId: w.tenantA },
        B(),
      );
      expect(a.status).toBe(200);
      expect(bOverride.status).toBe(200);
      const aBody = await json(a);
      const bBody = await json(bOverride);
      expect(aBody.tenantId).toBe(w.tenantA);
      expect(bBody.tenantId).toBe(w.tenantB);

      const listA = await json(await w.runtime.get('/v1/api/gateway/messaging-profiles', A()));
      const listB = await json(await w.runtime.get('/v1/api/gateway/messaging-profiles', B()));
      expect(listA.profiles.every((p: any) => p.tenantId === w.tenantA)).toBe(true);
      expect(listB.profiles.every((p: any) => p.tenantId === w.tenantB)).toBe(true);
      expect(listA.profiles.map((p: any) => p.id)).toContain(aBody.id);
      expect(listA.profiles.map((p: any) => p.id)).not.toContain(bBody.id);
      expect(listB.profiles.map((p: any) => p.id)).toContain(bBody.id);
      expect(listB.profiles.map((p: any) => p.id)).not.toContain(aBody.id);

      const otherApp = await json(await w.runtime.get('/v1/api/gateway/messaging-profiles', OTHER_APP()));
      expect(otherApp.profiles.map((p: any) => p.id)).not.toContain(aBody.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('suppliers — Application → Tenant → Supplier chain (Afribook / STAYSCAPE)', () => {
    it("tenant A reads its own supplier; tenant B (same app) and another app get 404 for it, by id and by slug", async () => {
      const own = await w.runtime.get(`/v1/api/gateway/suppliers/${w.supplierA.id}`, A());
      expect(own.status).toBe(200);
      expect((await json(own)).id).toBe(w.supplierA.id);
      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${w.supplierA.slug}`, A())).status).toBe(200);

      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${w.supplierA.id}`, B())).status).toBe(404);
      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${w.supplierA.slug}`, B())).status).toBe(404);
      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${w.supplierA.id}`, OTHER_APP())).status).toBe(404);
      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${w.otherAppSupplier.id}`, A())).status).toBe(404);
    });

    it("listing returns only the authenticated tenant's suppliers", async () => {
      const listA = await json(await w.runtime.get('/v1/api/gateway/suppliers', A()));
      const idsA = listA.suppliers.map((s: any) => s.id);
      expect(idsA).toContain(w.supplierA.id);
      expect(idsA).not.toContain(w.supplierB.id);
      expect(idsA).not.toContain(w.otherAppSupplier.id);
    });

    it('create: body applicationId / tenantId naming another app/tenant are ignored — the supplier belongs to the caller', async () => {
      const slug = `host-${randomUUID().slice(0, 8)}`;
      const r = await w.runtime.post(
        '/v1/api/gateway/suppliers',
        { name: 'Lakeside Lodge', slug, type: 'hotel', applicationId: w.otherApp.slug, tenantId: w.tenantB, tenant_id: w.tenantB },
        A(),
      );
      expect(r.status).toBe(201);
      const created = await json(r);
      expect(created.tenantId).toBe(w.tenantA);
      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${created.id}`, A())).status).toBe(200);
      expect((await w.runtime.get(`/v1/api/gateway/suppliers/${created.id}`, B())).status).toBe(404);
      // Same slug again for the same tenant is a conflict, not a second row.
      expect((await w.runtime.post('/v1/api/gateway/suppliers', { name: 'Dup', slug, type: 'hotel' }, A())).status).toBe(409);
    });

    it('acting as a supplier: tenant A may act for its own supplier; acting for B\'s or another app\'s supplier is 403', async () => {
      const own = await pay(A({ 'x-supplier-id': w.supplierA.id }));
      expect(own.status).toBe(200);
      expect(own.body.supplierId).toBe(w.supplierA.id);
      const row = await w.transactionRow(own.body.paymentTransactionId);
      expect((row?.metadata as any)?.bisSupplierId).toBe(w.supplierA.id);

      expect((await pay(A({ 'x-supplier-id': w.supplierB.id }))).status).toBe(403);
      expect((await pay(A({ 'x-supplier-id': w.supplierB.slug }))).status).toBe(403);
      expect((await pay(A({ 'x-supplier-id': w.otherAppSupplier.id }))).status).toBe(403);
      expect((await pay(B({ 'x-supplier-id': w.supplierA.id }))).status).toBe(403);
      expect((await pay(A({ 'x-supplier-id': 'not-a-real-supplier' }))).status).toBe(403);
    });

    it('a body supplierId never wins: without the header it is ignored; with the header the header (verified) wins', async () => {
      const noHeader = await pay(A(), { supplierId: w.supplierB.id, supplier_id: w.supplierB.id });
      expect(noHeader.status).toBe(200);
      expect(noHeader.body.supplierId).toBeUndefined();

      const withHeader = await pay(A({ 'x-supplier-id': w.supplierA.id }), { supplierId: w.supplierB.id });
      expect(withHeader.status).toBe(200);
      expect(withHeader.body.supplierId).toBe(w.supplierA.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('C4 chain: cross-tenant webhook leak → cross-tenant refund', () => {
    it("tenant B's endpoint never receives tenant A's payment/message/refund events; A's endpoint receives them", async () => {
      const epA = await registerEndpoint(A(), '/chain-a');
      const epB = await registerEndpoint(B(), '/chain-b');
      const epOther = await registerEndpoint(OTHER_APP(), '/chain-other');
      expect([epA.status, epB.status, epOther.status]).toEqual([201, 201, 201]);

      // Tenant A pays.
      const p = await pay(A(), { amount: 77 });
      expect(p.status).toBe(200);
      const paymentId = p.body.id as string;

      await deliverUntil((c) => c.some((x) => x.path === '/chain-a' && x.body?.id === paymentId), 'A receives its own payment event');
      await settleDeliveries();
      const toB = capture.captured.filter((x) => x.path === '/chain-b');
      const toOther = capture.captured.filter((x) => x.path === '/chain-other');
      expect(toB.some((x) => JSON.stringify(x.body).includes(paymentId))).toBe(false);
      expect(toOther.some((x) => JSON.stringify(x.body).includes(paymentId))).toBe(false);
      const deliveredToA = capture.captured.find((x) => x.path === '/chain-a' && x.body?.id === paymentId)!;
      expect(deliveredToA.body.tenantId).toBe(w.tenantA);
      expect(deliveredToA.body.appId).toBe(w.appSlug);
      expect(String(deliveredToA.headers['x-webhook-signature'])).toMatch(/^sha256=[0-9a-f]{64}$/);

      // Tenant A sends a message — same boundary for messaging events.
      const msg = await w.runtime.post('/v1/api/gateway/messaging', { recipient: '+15550009876', content: 'pastoral note for A only' }, A());
      const msgBody = await json(msg);
      expect(msg.status).toBe(200);
      await deliverUntil((c) => c.some((x) => x.path === '/chain-a' && x.body?.id === msgBody.id), 'A receives its own message event');
      await settleDeliveries();
      expect(capture.captured.filter((x) => x.path === '/chain-b').some((x) => JSON.stringify(x.body).includes('pastoral note for A only'))).toBe(false);

      // Tenant B — even having learned the payment id out of band — can
      // neither read it nor refund it.
      expect((await w.runtime.get(`/v1/api/gateway/transaction/${paymentId}`, B())).status).toBe(404);
      expect((await w.runtime.post('/refunds', { payment_id: paymentId, tenantId: w.tenantA }, B())).status).toBe(404);

      // Tenant A refunds; the refund event goes to A only.
      const refund = await w.runtime.post('/refunds', { payment_id: paymentId }, A());
      expect(refund.status).toBe(201);
      const refundBody = await json(refund);
      await deliverUntil((c) => c.some((x) => x.path === '/chain-a' && x.body?.id === refundBody.id), 'A receives its refund event');
      await settleDeliveries();
      expect(capture.captured.filter((x) => x.path === '/chain-b').some((x) => x.body?.id === refundBody.id)).toBe(false);

      // And B's endpoint does receive B's OWN events (the boundary is not "deliver nothing").
      const pb = await pay(B(), { amount: 11 });
      expect(pb.status).toBe(200);
      await deliverUntil((c) => c.some((x) => x.path === '/chain-b' && x.body?.id === pb.body.id), 'B receives its own payment event');
      expect(capture.captured.filter((x) => x.path === '/chain-a').some((x) => x.body?.id === pb.body.id)).toBe(false);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  describe('GW-1.1: inbound provider webhook attribution comes from the platform\'s own transaction row, never body metadata', () => {
    it("a signed webhook for tenant A's payment that CLAIMS tenant B / another app in its metadata is attributed to tenant A; the worker's event reaches A's endpoint only", async () => {
      const epA = await registerEndpoint(A(), '/wh-a');
      const epB = await registerEndpoint(B(), '/wh-b');
      expect([epA.status, epB.status]).toEqual([201, 201]);

      const p = await pay(A(), { amount: 50 });
      expect(p.status).toBe(200);
      const providerTxId = p.body.id as string;

      const evtId = `evt_p7_${randomUUID().slice(0, 12)}`;
      const body = buildStripeWebhook(providerTxId, {
        id: evtId,
        data: { metadata: { appId: w.otherApp.slug, tenantId: w.tenantB } },
      });
      const worker = await w.startWorker();
      try {
        const delivered = await deliverWebhook(w.runtime, 'stripe', body);
        expect(delivered.status).toBe(200);

        const row = await w.webhookEventRow('stripe', evtId);
        expect(row?.appId).toBe(w.appSlug);
        expect(row?.tenantId).toBe(w.tenantA);

        // The worker's payment_webhook consumer emits the processed event
        // (id = the provider event id) carrying the row's tenant; dispatch
        // sends it to tenant A's endpoint and nowhere else.
        await deliverUntil(
          (c) => c.some((x) => x.path === '/wh-a' && x.body?.id === evtId && x.body?.decisionReason === 'payment_webhook_received'),
          'A receives the processed provider webhook event',
        );
        await settleDeliveries();
        const toA = capture.captured.find((x) => x.path === '/wh-a' && x.body?.id === evtId)!;
        expect(toA.body.tenantId).toBe(w.tenantA);
        expect(toA.body.appId).toBe(w.appSlug);
        expect(capture.captured.filter((x) => x.path === '/wh-b').some((x) => x.body?.id === evtId || JSON.stringify(x.body).includes(providerTxId))).toBe(false);
      } finally {
        await stopWorker(worker);
      }
    }, 30_000);

    it('a signed webhook matching no platform transaction is recorded UNATTRIBUTED, whatever its metadata claims', async () => {
      const evtId = `evt_p7_${randomUUID().slice(0, 12)}`;
      const body = buildStripeWebhook(`pi_unknown_${randomUUID().slice(0, 10)}`, {
        id: evtId,
        data: { metadata: { appId: w.appSlug, tenantId: w.tenantB } },
      });
      const delivered = await deliverWebhook(w.runtime, 'stripe', body);
      expect(delivered.status).toBe(200);
      const row = await w.webhookEventRow('stripe', evtId);
      expect(row).toBeDefined();
      expect(row?.appId ?? null).toBeNull();
      expect(row?.tenantId ?? null).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('GW-1.2 / C8: admin playground always sends as a verified tenant', () => {
    const admin = () => ({ 'x-admin-token': w.adminToken });

    it('refuses a dispatch with no tenantId (400) or a tenant not linked to the application (403)', async () => {
      const noTenant = await w.runtime.post(
        '/api/dashboard/playground/dispatch',
        { category: 'messaging', appId: w.appSlug, recipient: '+15550001212', content: 'hi' },
        admin(),
      );
      expect(noTenant.status).toBe(400);
      const wrongTenant = await w.runtime.post(
        '/api/dashboard/playground/dispatch',
        { category: 'messaging', appId: w.appSlug, tenantId: w.otherApp.tenantId, recipient: '+15550001212', content: 'hi' },
        admin(),
      );
      expect(wrongTenant.status).toBe(403);
    });

    it("honours the tenant's STOP opt-out (it used to check consent under tenant 'default' and send anyway)", async () => {
      const recipient = `+1555${String(Date.now() % 10_000_000).padStart(7, '0')}`;
      const optOut = await w.runtime.post('/v1/api/consent', { recipient, channel: 'sms', status: 'opted_out' }, A());
      expect(optOut.status).toBe(200);
      const r = await w.runtime.post(
        '/api/dashboard/playground/dispatch',
        { category: 'messaging', appId: w.appSlug, tenantId: w.tenantA, recipient, content: 'admin test message' },
        admin(),
      );
      expect(r.status).toBe(403);
    });

    it("a playground payment is recorded on the named tenant and visibly marked admin-initiated", async () => {
      const r = await w.runtime.post(
        '/api/dashboard/playground/dispatch',
        { category: 'payment', appId: w.appSlug, tenantId: w.tenantA, amount: 3, currency: 'USD', providerOverride: 'stripe' },
        admin(),
      );
      expect(r.status).toBe(200);
      const body = await json(r);
      expect(body.tenantId).toBe(w.tenantA);
      expect(body.adminInitiated).toBe(true);
      expect(String(body.decisionReason)).toMatch(/^admin_playground:/);
      const row = await w.transactionRow(body.paymentTransactionId);
      expect(row?.tenantId).toBe(w.tenantA);
      expect((row?.metadata as any)?.bisSource).toBe('admin_playground');
      // Still tenant-scoped afterwards: tenant B cannot read it.
      expect((await w.runtime.get(`/v1/api/gateway/transaction/${body.id}`, B())).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('GW-1.4: log attribution never comes from the request body', () => {
    async function logFor(requestId: string) {
      let entry: any;
      await waitFor(
        () => {
          entry = logger
            .getRecentLogs()
            .find((l) => l.requestId === requestId && (l.message === 'request rejected' || l.message === 'request completed' || l.message === 'request failed'));
          return Boolean(entry);
        },
        { timeoutMs: 5_000, label: 'request log line' },
      );
      return entry;
    }

    it("an unauthenticated request's body tenantId/supplierId never reach the log's tenant/supplier attribution", async () => {
      const res = await w.runtime.post(
        '/v1/api/gateway/payment',
        { amount: 1, tenantId: 'attacker-chosen-tenant', supplierId: 'attacker-chosen-supplier' },
        { 'x-tenant-id': 'attacker-chosen-header' },
      );
      expect(res.status).toBe(401);
      const entry = await logFor(res.headers.get('x-request-id')!);
      expect(entry.tenantId).toBe('unknown');
      expect(JSON.stringify(entry)).not.toContain('attacker-chosen-tenant');
      expect(JSON.stringify(entry)).not.toContain('attacker-chosen-supplier');
      // The raw claim is kept only under an explicitly unverified name.
      expect(entry.unverifiedTenantHeader).toBe('attacker-chosen-header');
    });

    it("a rejected (unlinked-tenant) request is attributed to 'unknown', not to the tenant it claimed", async () => {
      const res = await w.runtime.post('/v1/api/gateway/payment', { amount: 1, tenantId: w.tenantA }, as(w.otherApp.tenantId));
      expect(res.status).toBe(403);
      const entry = await logFor(res.headers.get('x-request-id')!);
      expect(entry.tenantId).toBe('unknown');
      expect(entry.tenantId).not.toBe(w.tenantA);
    });

    it('an authenticated request is attributed to its VERIFIED tenant even when the body names another', async () => {
      const res = await w.runtime.post(
        '/v1/api/gateway/payment',
        { amount: 2, currency: 'USD', providerOverride: 'stripe', tenantId: w.tenantB },
        A(),
      );
      expect(res.status).toBe(200);
      const entry = await logFor(res.headers.get('x-request-id')!);
      expect(entry.tenantId).toBe(w.tenantA);
      expect(entry.applicationId).toBe(w.appSlug);
    });
  });
}
