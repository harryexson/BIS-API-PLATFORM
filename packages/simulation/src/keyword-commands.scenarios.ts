import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
  tenantRepository,
  tenantApplicationLinkRepository,
  consentRecordRepository,
  conversationRepository,
  senderOptOutRepository,
} from '@company/database';
import type { TransactionEvent } from '@company/schemas';
import {
  buildInboundSms,
  deliverWebhook,
  drain,
  stopWorker,
  waitFor,
  type SimRuntime,
  type WorkerHandle,
} from './harness';

/**
 * Phase 9 — tenant-configurable inbound keyword commands (gap register A13)
 * and the full inbound pipeline:
 *
 *   provider webhook → destination number → owner (Phase 8 resolver) →
 *   conversation → keyword recognition against THAT owner's configuration →
 *   dispatch (universal: handled + reply really delivered; app-specific
 *   'dispatch': durable row + tenant-scoped event + webhook) → audit.
 *
 * Run black-box through the REAL gateway (tenant keyword-command routes,
 * admin application-default routes, messaging-profile registration, the
 * durable inbound webhook route, the admin hold routes, the dispatch pull /
 * ack routes, outbound webhook registration) and the REAL worker
 * (inbound_message + keyword_response_delivery), against two back-ends:
 *   - keyword-commands.postgres.integration.test.ts — real repositories on a
 *     real PostgreSQL migrated from zero (incl. migration 0018);
 *   - keyword-commands.simulation.test.ts — the in-memory double.
 *
 * World — three very different businesses on one platform:
 *   Reach Church (a church app, TWO tenant congregations: Grace, Hope)
 *   HaulPro      (logistics / trucking)
 *   Afribook     (a marketplace that configures no commands at all)
 * SHARED is one Malawi number shared by Grace, HaulPro and Afribook; every
 * owner also has a dedicated number.
 */

export const SHARED = '+265991100001';
export const GRACE_DED = '+265991100010';
export const HOPE_DED = '+265991100011';
export const HAUL_DED = '+265991100020';
export const AFRI_DED = '+265991100030';

export interface KwParty {
  appSlug: string;
  apiKey: string;
  tenantId: string;
}

export interface KeywordWorld {
  runtime: SimRuntime;
  adminToken: string;
  grace: KwParty;
  hope: KwParty;
  haulpro: KwParty;
  afribook: KwParty;
  /** Every `events` row whose payload.sender or payload.recipient is this customer (any app, any category). */
  eventsFor(customer: string): Promise<Array<{ appId: string; category: string; decisionReason: string | null; payload: any }>>;
  startWorker(): Promise<WorkerHandle>;
}

/** Builds the apps/tenants through @company/database (real or double). */
export async function seedKeywordParties(): Promise<Pick<KeywordWorld, 'grace' | 'hope' | 'haulpro' | 'afribook'>> {
  const suffix = randomBytes(3).toString('hex');
  const registry = new ApplicationRegistry(applicationRepository, apiKeyRepository);
  async function app(name: string, slug: string) {
    return registry.createApplication({ name: `${name} ${suffix}`, slug: `${slug}-${suffix}` });
  }
  async function tenantOf(created: Awaited<ReturnType<typeof app>>, tenantName: string, tenantSlug: string): Promise<KwParty> {
    const tenant = await tenantRepository.create({ name: tenantName, slug: `${tenantSlug}-${suffix}` });
    await tenantApplicationLinkRepository.link(tenant.id, created.application.id);
    return { appSlug: created.application.slug, apiKey: created.apiKey.raw, tenantId: tenant.id };
  }
  const reach = await app('Reach Church', 'reach-church');
  const haul = await app('HaulPro', 'haulpro');
  const afri = await app('Afribook', 'afribook');
  return {
    grace: await tenantOf(reach, 'Grace Congregation', 'grace'),
    hope: await tenantOf(reach, 'Hope Chapel', 'hope'),
    haulpro: await tenantOf(haul, 'HaulPro Lilongwe', 'haulpro-llw'),
    afribook: await tenantOf(afri, 'Afribook Malawi', 'afribook-mw'),
  };
}

let seq = 0;
function customer(): string {
  seq += 1;
  return `+26589${String(Date.now() % 100000).padStart(5, '0')}${String(seq).padStart(2, '0')}`;
}

export function registerKeywordCommandScenarios(getWorld: () => KeywordWorld): void {
  let w: KeywordWorld;
  let worker: WorkerHandle;
  const bus: TransactionEvent[] = [];
  let unsubscribe: () => void = () => undefined;

  const auth = (p: KwParty) => ({ authorization: `Bearer ${p.apiKey}`, 'x-tenant-id': p.tenantId });
  const admin = () => ({ 'x-admin-token': w.adminToken });

  async function json(method: string, path: string, body: unknown, headers: Record<string, string>) {
    const res = await w.runtime.request(method, path, {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const putCommand = (p: KwParty, keyword: string, body: unknown) =>
    json('PUT', `/v1/api/gateway/keyword-commands/${encodeURIComponent(keyword)}`, body, auth(p));

  async function registerNumber(p: KwParty, sender: string, provider: string) {
    const res = await w.runtime.post('/v1/api/gateway/messaging-profiles', { country: 'MW', senderType: 'phone', sender, provider }, auth(p));
    expect(res.status, await res.clone().text()).toBe(200);
  }

  async function send(p: KwParty, recipient: string, content: string, provider = 'signalhouse') {
    const res = await w.runtime.post('/v1/api/gateway/messaging', { recipient, content, providerOverride: provider }, auth(p));
    return res.status;
  }

  /** Customer → provider → webhook → durable row → inbound_message → keyword_response_delivery. */
  async function inbound(from: string, to: string, text: string, provider = 'signalhouse') {
    const delivery = await deliverWebhook(w.runtime, provider, buildInboundSms({ from, to, text, provider }));
    expect(delivery.status).toBe(200);
    await drain(worker, ['inbound_message', 'keyword_response_delivery']);
  }

  async function holdsFor(c: string, status = 'pending') {
    const res = await w.runtime.get(`/api/dashboard/inbound-holds?status=${status}&limit=500`, admin());
    return ((await res.json()).data as any[]).filter((h) => h.customerPhone === c);
  }

  async function resolveHold(id: string, p: KwParty, note: string) {
    const res = await w.runtime.post(
      `/api/dashboard/inbound-holds/${id}/resolve`,
      { appId: p.appSlug, tenantId: p.tenantId, note, resolvedBy: 'ops@bis' },
      admin(),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    await drain(worker, ['inbound_message', 'keyword_response_delivery']);
  }

  /** Keyword replies actually SENT (written by keyword_response_delivery after the provider call). */
  async function deliveredReplies(c: string) {
    return (await w.eventsFor(c)).filter(
      (r) => r.category === 'messaging' && String(r.decisionReason).startsWith('keyword_response:') && r.payload?.recipient === c,
    );
  }

  async function dispatchesOf(p: KwParty, status?: string) {
    const res = await w.runtime.get(`/v1/api/gateway/keyword-dispatches${status ? `?status=${status}` : ''}`, auth(p));
    expect(res.status).toBe(200);
    return (await res.json()).data as any[];
  }

  const consent = async (p: KwParty, c: string) =>
    (await consentRecordRepository.findByRecipient(p.appSlug, p.tenantId, c, 'sms'))?.status;

  beforeAll(async () => {
    w = getWorld();
    worker = await w.startWorker();
    unsubscribe = w.runtime.bus.subscribe((e: TransactionEvent) => {
      bus.push(e);
    });
    await registerNumber(w.grace, SHARED, 'signalhouse');
    await registerNumber(w.haulpro, SHARED, 'signalhouse');
    await registerNumber(w.afribook, SHARED, 'signalhouse');
    await registerNumber(w.grace, GRACE_DED, 'infobip');
    await registerNumber(w.hope, HOPE_DED, 'infobip');
    await registerNumber(w.haulpro, HAUL_DED, 'infobip');
    await registerNumber(w.afribook, AFRI_DED, 'infobip');

    // Reach Church APPLICATION-wide default (operator-managed), inherited by
    // every congregation of the application.
    const appDefault = await json(
      'PUT',
      `/api/dashboard/applications/${w.grace.appSlug}/keyword-commands/PRAY`,
      { action: 'reply', responseText: 'Your prayer request has been received. Our prayer team will pray for you.', helpText: 'send a prayer request', updatedBy: 'ops@bis' },
      admin(),
    );
    expect(appDefault.status, JSON.stringify(appDefault.body)).toBe(200);
    // Grace adds a church check-in command handled by its own backend.
    expect((await putCommand(w.grace, 'CHECK IN', {
      action: 'dispatch', aliases: ['CHECKIN'], workflowId: 'reach.service_check_in', helpText: 'check in to a service',
    })).status).toBe(200);
    // Hope Chapel (same application) words PRAY its own way.
    expect((await putCommand(w.hope, 'PRAY', {
      action: 'reply', responseText: 'Hope Chapel has received your prayer request. Pastor Banda will call you.', helpText: 'prayer request',
    })).status).toBe(200);
    // HaulPro: a logistics command handled by HaulPro's own backend, plus its own HELP wording.
    expect((await putCommand(w.haulpro, 'WHERE IS MY DRIVER', {
      action: 'dispatch',
      aliases: ['WHERES MY DRIVER', 'DRIVER STATUS'],
      workflowId: 'haulpro.driver_eta',
      responseText: 'Thanks — HaulPro dispatch is checking on your driver and will text you shortly.',
      helpText: 'driver status',
    })).status).toBe(200);
    expect((await putCommand(w.haulpro, 'HELP', {
      action: 'reply', responseText: 'HaulPro support: call +265 1 000 000. Reply STOP to opt out. {commands}',
    })).status).toBe(200);
    // Afribook configures nothing.
  }, 60_000);

  afterAll(async () => {
    unsubscribe();
    if (worker) await stopWorker(worker);
  });

  describe('Problem 1 — each tenant type gets its OWN keyword set and wording (no church wording for non-church tenants)', () => {
    it('HELP is built per owner: church lists PRAY/CHECK IN; logistics lists WHERE IS MY DRIVER in its own wording; marketplace gets the neutral default — and each reply is really delivered', async () => {
      const cg = customer();
      const ch = customer();
      const ca = customer();
      await inbound(cg, GRACE_DED, 'HELP', 'infobip');
      await inbound(ch, HAUL_DED, 'help', 'infobip');
      await inbound(ca, AFRI_DED, 'HELP?', 'infobip');

      const [grace] = await deliveredReplies(cg);
      const [haul] = await deliveredReplies(ch);
      const [afri] = await deliveredReplies(ca);
      for (const [row, party] of [[grace, w.grace], [haul, w.haulpro], [afri, w.afribook]] as const) {
        expect(row, `HELP reply delivered for ${party.appSlug}`).toBeDefined();
        expect(row.appId).toBe(party.appSlug);
        expect(row.decisionReason).toBe('keyword_response:help');
        expect(row.payload.tenantId).toBe(party.tenantId);
        expect(row.payload.content).toMatch(/STOP/); // compliance content always present
      }
      expect(grace.payload.content).toContain('PRAY (send a prayer request)');
      expect(grace.payload.content).toContain('CHECK IN (check in to a service)');
      expect(grace.payload.content).not.toMatch(/DRIVER/);

      expect(haul.payload.content).toBe('HaulPro support: call +265 1 000 000. Reply STOP to opt out. Commands: WHERE IS MY DRIVER (driver status).');
      expect(haul.payload.content).not.toMatch(/PRAY|prayer/i);

      expect(afri.payload.content).toBe('Reply STOP to unsubscribe, START to resubscribe, HELP for help.');
      expect(afri.payload.content).not.toMatch(/PRAY|prayer|DRIVER/i);
    });

    it('PRAY is a command only for the church tenants — with each congregation\'s own wording — and plain content for HaulPro', async () => {
      const cg = customer();
      const cp = customer();
      const ch = customer();
      await inbound(cg, GRACE_DED, 'PRAY', 'infobip');
      await inbound(cp, HOPE_DED, 'pray for my mother', 'infobip');
      await inbound(ch, HAUL_DED, 'PRAY', 'infobip');

      // Grace inherits the application default.
      const grace = await w.eventsFor(cg);
      expect(grace.some((r) => r.decisionReason === 'keyword_command:PRAY' && r.appId === w.grace.appSlug && r.payload.tenantId === w.grace.tenantId)).toBe(true);
      expect((await deliveredReplies(cg))[0].payload.content).toBe('Your prayer request has been received. Our prayer team will pray for you.');
      // Hope overrides the wording; the rest of the message is the argument.
      const hope = await w.eventsFor(cp);
      const hopeCmd = hope.find((r) => r.decisionReason === 'keyword_command:PRAY');
      expect(hopeCmd?.payload.tenantId).toBe(w.hope.tenantId);
      expect(hopeCmd?.payload.argument).toBe('for my mother');
      expect((await deliveredReplies(cp))[0].payload.content).toBe('Hope Chapel has received your prayer request. Pastor Banda will call you.');
      // HaulPro never configured PRAY: ordinary inbound content, no reply, no prayer wording.
      const haul = await w.eventsFor(ch);
      expect(haul.some((r) => String(r.decisionReason).startsWith('keyword_'))).toBe(false);
      expect(haul.filter((r) => String(r.decisionReason).startsWith('inbound_from_')).map((r) => r.appId)).toEqual([w.haulpro.appSlug]);
      expect(await deliveredReplies(ch)).toHaveLength(0);
    });

    it('configuration is validated: compliance keywords keep their semantics and compliance wording; nothing can shadow STOP', async () => {
      const stopAsDispatch = await putCommand(w.haulpro, 'STOP', { action: 'dispatch', workflowId: 'x' });
      expect(stopAsDispatch.status).toBe(400);
      expect(stopAsDispatch.body.error.field).toBe('action');
      const shadowed = await putCommand(w.haulpro, 'CANCEL ORDER', { action: 'dispatch' });
      expect(shadowed.status).toBe(400); // CANCEL … is an opt-out keyword
      const helpWithoutStop = await putCommand(w.afribook, 'HELP', { action: 'reply', responseText: 'Afribook: visit afribook.example' });
      expect(helpWithoutStop.status).toBe(400);
      const disableStop = await putCommand(w.afribook, 'STOP', { action: 'reply', responseText: 'bye, reply START', enabled: false });
      expect(disableStop.status).toBe(400);
      const aliasClash = await putCommand(w.haulpro, 'TRACK', { action: 'dispatch', aliases: ['DRIVER STATUS'] });
      expect(aliasClash.status).toBe(400);
      // A tenant only ever sees and edits its own + its application's rows.
      const view = await json('GET', '/v1/api/gateway/keyword-commands', undefined, auth(w.afribook));
      expect(view.status).toBe(200);
      expect(view.body.effective).toEqual([]);
      const graceView = await json('GET', '/v1/api/gateway/keyword-commands', undefined, auth(w.grace));
      expect(graceView.body.effective.map((c: any) => c.keyword).sort()).toEqual(['CHECK IN', 'PRAY']);
      expect(graceView.body.effective.find((c: any) => c.keyword === 'PRAY').scope).toBe('application');
    });

    it('a tenant can switch off an inherited application command for itself only', async () => {
      expect((await putCommand(w.hope, 'PRAY', { action: 'reply', enabled: false })).status).toBe(200);
      const cp = customer();
      const cg = customer();
      await inbound(cp, HOPE_DED, 'PRAY', 'infobip');
      await inbound(cg, GRACE_DED, 'PRAY', 'infobip');
      expect((await w.eventsFor(cp)).some((r) => r.decisionReason === 'keyword_command:PRAY')).toBe(false);
      expect((await w.eventsFor(cg)).some((r) => r.decisionReason === 'keyword_command:PRAY')).toBe(true);
      // restore Hope's own wording for later tests
      expect((await putCommand(w.hope, 'PRAY', { action: 'reply', responseText: 'Hope Chapel has received your prayer request.' })).status).toBe(200);
    });
  });

  describe('Problem 2 — CHECK IN / WHERE IS MY DRIVER: recognised, attributed to the right owner, dispatched generically', () => {
    let hook: { server: Server; url: string; received: Array<{ path: string; body: any }> };

    beforeAll(async () => {
      const received: Array<{ path: string; body: any }> = [];
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          received.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
          res.writeHead(200).end('{}');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      hook = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
      // HaulPro subscribes to keyword commands only; Grace to everything.
      const h = await w.runtime.post('/v1/api/gateway/webhooks', { url: `${hook.url}/haulpro`, events: ['messaging.keyword_command'] }, auth(w.haulpro));
      expect(h.status).toBe(201);
      const g = await w.runtime.post('/v1/api/gateway/webhooks', { url: `${hook.url}/grace`, events: ['*'] }, auth(w.grace));
      expect(g.status).toBe(201);
    });

    afterAll(async () => {
      await new Promise<void>((r) => hook.server.close(() => r()));
    });

    it('WHERE IS MY DRIVER on HaulPro\'s number → durable dispatch + tenant-scoped event + webhook to HaulPro only; the platform invents no driver data', async () => {
      const c = customer();
      const before = bus.length;
      await inbound(c, HAUL_DED, 'Where is my driver?', 'infobip');

      const [d] = await dispatchesOf(w.haulpro, 'pending').then((rows) => rows.filter((r) => r.customerPhone === c));
      expect(d).toMatchObject({ keyword: 'WHERE IS MY DRIVER', workflowId: 'haulpro.driver_eta', businessNumber: HAUL_DED, content: 'Where is my driver?', argument: null });
      expect(d.conversationId).toBeTruthy();
      // Workflow resolution recorded on the conversation the command arrived on.
      const [conv] = await conversationRepository.findActiveByPhone(c);
      expect(conv.appId).toBe(w.haulpro.appSlug);
      expect(conv.workflowId).toBe('haulpro.driver_eta');
      // Tenant-scoped event for HaulPro (nothing for anyone else).
      const evt = bus.slice(before).find((e) => e.decisionReason === 'keyword_command:WHERE IS MY DRIVER');
      expect(evt).toMatchObject({ appId: w.haulpro.appSlug, tenantId: w.haulpro.tenantId, messageType: 'keyword_command' });
      expect(evt!.payload).toMatchObject({ type: 'keyword.command', dispatchId: d.id, keyword: 'WHERE IS MY DRIVER', sender: c });
      expect(bus.slice(before).some((e) => e.appId !== w.haulpro.appSlug && JSON.stringify(e.payload ?? {}).includes(c) && e.tenantId)).toBe(false);
      // The only automated reply is HaulPro's OWN configured acknowledgement — no fabricated location/ETA.
      const replies = await deliveredReplies(c);
      expect(replies.map((r) => r.payload.content)).toEqual(['Thanks — HaulPro dispatch is checking on your driver and will text you shortly.']);
      // Push: delivered to HaulPro's webhook endpoint, signed, and never to Grace's.
      await waitFor(async () => {
        await w.runtime.gatewayWebhookDelivery.flush();
        return hook.received.some((r) => r.path === '/haulpro' && r.body?.payload?.dispatchId === d.id);
      }, { timeoutMs: 10_000, label: 'haulpro webhook' });
      expect(hook.received.some((r) => r.path === '/grace' && JSON.stringify(r.body).includes(d.id))).toBe(false);
      // Pull: no other tenant can see or acknowledge it.
      expect((await dispatchesOf(w.grace)).some((r) => r.id === d.id)).toBe(false);
      expect((await json('POST', `/v1/api/gateway/keyword-dispatches/${d.id}/ack`, {}, auth(w.grace))).status).toBe(404);
      const ack = await json('POST', `/v1/api/gateway/keyword-dispatches/${d.id}/ack`, {}, auth(w.haulpro));
      expect(ack.status).toBe(200);
      expect(ack.body.status).toBe('acknowledged');
      expect((await dispatchesOf(w.haulpro, 'pending')).some((r) => r.id === d.id)).toBe(false);
    });

    it('CHECK IN (alias + argument) for Grace is dispatched to Grace with its workflow; "CHECK IN" means nothing to HaulPro', async () => {
      const cg = customer();
      const ch = customer();
      await inbound(cg, GRACE_DED, 'check-in 0930', 'infobip');
      await inbound(ch, HAUL_DED, 'CHECK IN', 'infobip');
      const [d] = (await dispatchesOf(w.grace)).filter((r) => r.customerPhone === cg);
      expect(d).toMatchObject({ keyword: 'CHECK IN', argument: '0930', workflowId: 'reach.service_check_in' });
      expect((await dispatchesOf(w.haulpro)).some((r) => r.customerPhone === ch)).toBe(false);
      expect((await w.eventsFor(ch)).filter((r) => String(r.decisionReason).startsWith('inbound_from_')).map((r) => r.appId)).toEqual([w.haulpro.appSlug]);
      // No acknowledgement configured for CHECK IN: the platform sends nothing on Grace's behalf.
      expect(await deliveredReplies(cg)).toHaveLength(0);
    });

    it('shared number, customer only talks to HaulPro on it → WHERE IS MY DRIVER is attributed to HaulPro by the Phase 8 resolver, even though the church and the marketplace share the number', async () => {
      const c = customer();
      expect(await send(w.haulpro, c, 'Your load has been collected')).toBe(200);
      await inbound(c, SHARED, 'WHERES MY DRIVER');
      const mine = (await dispatchesOf(w.haulpro)).filter((r) => r.customerPhone === c);
      expect(mine).toHaveLength(1);
      expect(mine[0].businessNumber).toBe(SHARED);
      expect((await dispatchesOf(w.grace)).some((r) => r.customerPhone === c)).toBe(false);
      expect((await dispatchesOf(w.afribook)).some((r) => r.customerPhone === c)).toBe(false);
      expect(await holdsFor(c)).toHaveLength(0);
    });

    it('a redelivered webhook records the command once', async () => {
      const c = customer();
      const body = buildInboundSms({ from: c, to: HAUL_DED, text: 'DRIVER STATUS', provider: 'infobip' });
      expect((await deliverWebhook(w.runtime, 'infobip', body)).status).toBe(200);
      expect((await deliverWebhook(w.runtime, 'infobip', body)).status).toBe(200);
      await drain(worker, ['inbound_message', 'keyword_response_delivery']);
      expect((await dispatchesOf(w.haulpro)).filter((r) => r.customerPhone === c)).toHaveLength(1);
      expect(await deliveredReplies(c)).toHaveLength(1);
    });

    it('genuinely ambiguous on the shared number → held, dispatched to NOBODY; the hold only HINTS which candidate has the command; operator attribution then dispatches to HaulPro', async () => {
      const c = customer();
      expect(await send(w.grace, c, 'Sunday service at 9')).toBe(200);
      expect(await send(w.haulpro, c, 'Truck booked')).toBe(200);
      await inbound(c, SHARED, 'where is my driver');

      expect((await dispatchesOf(w.haulpro)).some((r) => r.customerPhone === c)).toBe(false);
      expect((await dispatchesOf(w.grace)).some((r) => r.customerPhone === c)).toBe(false);
      expect(await deliveredReplies(c)).toHaveLength(0);
      const [hold] = await holdsFor(c);
      expect(hold.reason).toBe('ambiguous_owner');
      const byApp = Object.fromEntries(hold.candidates.map((x: any) => [x.appId, x.matchedCommand ?? null]));
      expect(byApp[w.haulpro.appSlug]).toBe('WHERE IS MY DRIVER');
      expect(byApp[w.grace.appSlug]).toBeNull();

      await resolveHold(hold.id, w.haulpro, 'only HaulPro has drivers');
      const [d] = (await dispatchesOf(w.haulpro)).filter((r) => r.customerPhone === c);
      expect(d.keyword).toBe('WHERE IS MY DRIVER');
      expect((await dispatchesOf(w.grace)).some((r) => r.customerPhone === c)).toBe(false);
    });
  });

  describe('Problem 3 — START restores eligibility only for the owner it is attributed to; never a blanket re-subscribe', () => {
    it('STOP confirmation is really delivered (the one message allowed after opt-out); later replies to the opted-out customer are suppressed, not retried', async () => {
      const c = customer();
      await inbound(c, HAUL_DED, 'STOP', 'infobip');
      expect(await consent(w.haulpro, c)).toBe('opted_out');
      const replies = await deliveredReplies(c);
      expect(replies.map((r) => r.decisionReason)).toEqual(['keyword_response:opt_out']);
      expect(replies[0].payload.content).toMatch(/START/);
      expect(await send(w.haulpro, c, 'promo', 'infobip')).toBe(403);

      await inbound(c, HAUL_DED, 'WHERE IS MY DRIVER', 'infobip');
      // The command is still dispatched to HaulPro (the customer asked), but
      // no automated acknowledgement is sent to an opted-out customer.
      expect((await dispatchesOf(w.haulpro)).some((r) => r.customerPhone === c)).toBe(true);
      expect((await deliveredReplies(c)).map((r) => r.decisionReason)).toEqual(['keyword_response:opt_out']);
      expect((await w.eventsFor(c)).some((r) => r.decisionReason === 'keyword_response_suppressed:command')).toBe(true);
    });

    it('routed START on one tenant\'s number restores THAT tenant only, auditable; the other tenant the customer stopped stays stopped', async () => {
      const c = customer();
      await inbound(c, GRACE_DED, 'STOP', 'infobip');
      await inbound(c, HAUL_DED, 'STOP', 'infobip');
      expect(await consent(w.grace, c)).toBe('opted_out');
      expect(await consent(w.haulpro, c)).toBe('opted_out');

      await inbound(c, HAUL_DED, 'START', 'infobip');

      expect(await consent(w.haulpro, c)).toBe('opted_in');
      expect(await consent(w.grace, c)).toBe('opted_out');
      expect(await send(w.haulpro, c, 'Welcome back', 'infobip')).toBe(200);
      expect(await send(w.grace, c, 'Hello?', 'infobip')).toBe(403);
      // Audit: one keyword_join, under HaulPro, with how the owner was established.
      const joins = (await w.eventsFor(c)).filter((r) => r.decisionReason === 'keyword_join');
      expect(joins).toHaveLength(1);
      expect(joins[0]).toMatchObject({ appId: w.haulpro.appSlug });
      expect(joins[0].payload).toMatchObject({ tenantId: w.haulpro.tenantId, attribution: 'conversation' });
      const record = await consentRecordRepository.findByRecipient(w.haulpro.appSlug, w.haulpro.tenantId, c, 'sms');
      expect(record).toMatchObject({ status: 'opted_in', source: 'keyword', keyword: 'JOIN' });
    });

    it('shared number, customer stopped BOTH tenants: an ambiguous START clears only the carrier-level number block — neither tenant is re-subscribed until the START is attributed, and then only that one', async () => {
      const c = customer();
      expect(await send(w.grace, c, 'Weekly devotional')).toBe(200);
      expect(await send(w.haulpro, c, 'Rate your driver')).toBe(200);
      // Two STOPs, each ambiguous → held → attributed by an operator.
      await inbound(c, SHARED, 'STOP');
      const [stop1] = await holdsFor(c);
      await resolveHold(stop1.id, w.grace, 'customer: stop church texts');
      await inbound(c, SHARED, 'STOP please');
      const [stop2] = await holdsFor(c);
      await resolveHold(stop2.id, w.haulpro, 'customer: stop truck texts');
      expect(await consent(w.grace, c)).toBe('opted_out');
      expect(await consent(w.haulpro, c)).toBe('opted_out');
      expect((await senderOptOutRepository.find(SHARED, c, 'sms'))?.status).toBe('opted_out');

      await inbound(c, SHARED, 'START');

      const [startHold] = await holdsFor(c);
      expect(startHold.keyword).toBe('JOIN');
      expect(startHold.senderOptOutApplied).toBe(true);
      const numberLevel = await senderOptOutRepository.find(SHARED, c, 'sms');
      expect(numberLevel).toMatchObject({ status: 'opted_in', source: 'keyword_held', keyword: 'JOIN', holdId: startHold.id });
      // No tenant silently re-subscribed.
      expect(await consent(w.grace, c)).toBe('opted_out');
      expect(await consent(w.haulpro, c)).toBe('opted_out');
      expect((await w.eventsFor(c)).some((r) => r.decisionReason === 'keyword_join')).toBe(false);
      expect(await send(w.grace, c, 'Back?')).toBe(403);
      expect(await send(w.haulpro, c, 'Back?')).toBe(403);
      expect(await deliveredReplies(c).then((r) => r.filter((x) => x.decisionReason === 'keyword_response:opt_in'))).toHaveLength(0);

      // Operator attributes the START to HaulPro → HaulPro only.
      await resolveHold(startHold.id, w.haulpro, 'customer wants truck updates again');
      expect(await consent(w.haulpro, c)).toBe('opted_in');
      expect(await consent(w.grace, c)).toBe('opted_out');
      const joins = (await w.eventsFor(c)).filter((r) => r.decisionReason === 'keyword_join');
      expect(joins.map((r) => r.appId)).toEqual([w.haulpro.appSlug]);
      expect(joins[0].payload.holdId).toBe(startHold.id);
      expect(String(joins[0].payload.attribution)).toBe('operator:ops@bis');
      expect(await send(w.haulpro, c, 'Welcome back')).toBe(200);
      expect(await send(w.grace, c, 'Welcome back')).toBe(403);
    });
  });
}
