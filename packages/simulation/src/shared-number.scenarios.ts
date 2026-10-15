import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
  tenantRepository,
  tenantApplicationLinkRepository,
  supplierRepository,
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
  type SimRuntime,
  type WorkerHandle,
} from './harness';

/**
 * Phase 8 — shared phone numbers: conversation ownership (gap register
 * A1, A2, A3, A4, A5, D12).
 *
 * One adversarial suite, run black-box through the REAL gateway (outbound
 * POST /v1/api/gateway/messaging, messaging-profile registration, the
 * durable inbound webhook route, the admin hold routes) and the REAL
 * inbound_message worker, against two database back-ends:
 *   - shared-number.postgres.integration.test.ts — real repositories on a
 *     real PostgreSQL migrated from zero (the authoritative proof);
 *   - shared-number.simulation.test.ts — the in-memory double, so the same
 *     assertions also run in a plain `npx vitest run`.
 *
 * World (the platform's real cost model: ONE local number per country,
 * shared by several applications/tenants):
 *   SHARED_MW  — Malawi shared number, provider signalhouse, registered to
 *                Reach Church, HaulPro AND STAYSCAPE (tenant-level).
 *   HAUL_ZM    — HaulPro's Zambia number (signalhouse).
 *   REACH_DED  — a number dedicated to Reach Church (provider infobip).
 *   STAYSCAPE  — one tenant with two hotels (suppliers) that share
 *                SHARED_MW; later in the suite hotel A gets its own number.
 *
 * Every conversation is created by a REAL outbound send through the
 * gateway, in an order that makes the WRONG owner the most recently active
 * one — i.e. each scenario is one the pre-Phase-8 "most recent wins"
 * resolver got wrong.
 */

export const SHARED_MW = '+265991000001';
export const HAUL_ZM = '+260971000002';
export const REACH_DED = '+265991000099';

export interface Party {
  appSlug: string;
  apiKey: string;
  tenantId: string;
}

export interface SharedNumberWorld {
  runtime: SimRuntime;
  adminToken: string;
  reach: Party;
  haulpro: Party;
  stayscape: Party & { hotelA: string; hotelB: string };
  /** Every row in `events` whose payload.sender is this customer (any app). */
  eventsFor(customer: string): Promise<Array<{ appId: string; decisionReason: string | null; payload: any }>>;
  startWorker(): Promise<WorkerHandle>;
}

/** Builds the apps/tenants/suppliers through @company/database (real or double). */
export async function seedSharedNumberParties(): Promise<Pick<SharedNumberWorld, 'reach' | 'haulpro' | 'stayscape'>> {
  const suffix = randomBytes(3).toString('hex');
  const registry = new ApplicationRegistry(applicationRepository, apiKeyRepository);
  async function party(name: string, slug: string, tenantName: string) {
    const app = await registry.createApplication({ name: `${name} ${suffix}`, slug: `${slug}-${suffix}` });
    const tenant = await tenantRepository.create({ name: tenantName, slug: `${slug}-tenant-${suffix}` });
    await tenantApplicationLinkRepository.link(tenant.id, app.application.id);
    return { app, party: { appSlug: app.application.slug, apiKey: app.apiKey.raw, tenantId: tenant.id } };
  }
  const reach = await party('Reach Church', 'reach-church', 'Grace Congregation');
  const haul = await party('HaulPro', 'haulpro', 'HaulPro Lilongwe');
  const stay = await party('STAYSCAPE', 'stayscape', 'Lakeshore Hosts');
  const hotelA = await supplierRepository.create({
    applicationId: stay.app.application.id, tenantId: stay.party.tenantId, name: 'Hotel Mangochi', slug: 'hotel-mangochi', type: 'hotel',
  });
  const hotelB = await supplierRepository.create({
    applicationId: stay.app.application.id, tenantId: stay.party.tenantId, name: 'Hotel Salima', slug: 'hotel-salima', type: 'hotel',
  });
  return { reach: reach.party, haulpro: haul.party, stayscape: { ...stay.party, hotelA: hotelA.id, hotelB: hotelB.id } };
}

let customerSeq = 0;
function customer(country: 'MW' | 'ZM'): string {
  customerSeq += 1;
  const tail = String(Date.now() % 100000).padStart(5, '0') + String(customerSeq).padStart(2, '0');
  return country === 'MW' ? `+26588${tail}` : `+26097${tail}`;
}

export function registerSharedNumberScenarios(getWorld: () => SharedNumberWorld): void {
  let w: SharedNumberWorld;
  let worker: WorkerHandle;
  const bus: TransactionEvent[] = [];
  let unsubscribe: () => void = () => undefined;

  const auth = (p: Party, supplierId?: string) => ({
    authorization: `Bearer ${p.apiKey}`,
    'x-tenant-id': p.tenantId,
    ...(supplierId ? { 'x-supplier-id': supplierId } : {}),
  });
  const admin = () => ({ 'x-admin-token': w.adminToken });

  async function registerNumber(p: Party, sender: string, country: string, provider = 'signalhouse', supplierId?: string) {
    const res = await w.runtime.post('/v1/api/gateway/messaging-profiles', { country, senderType: 'phone', sender, provider }, auth(p, supplierId));
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  }

  async function send(p: Party, recipient: string, content: string, opts: { provider?: string; supplierId?: string } = {}) {
    const res = await w.runtime.post(
      '/v1/api/gateway/messaging',
      { recipient, content, providerOverride: opts.provider ?? 'signalhouse' },
      auth(p, opts.supplierId),
    );
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  /** Customer → provider → platform webhook → durable row → inbound_message job → worker. */
  async function inbound(from: string, to: string, text: string, provider = 'signalhouse') {
    const delivery = await deliverWebhook(w.runtime, provider, buildInboundSms({ from, to, text, provider }));
    expect(delivery.status).toBe(200);
    await drain(worker, ['inbound_message']);
  }

  async function holdsFor(customerPhone: string, status = 'pending') {
    const res = await w.runtime.get(`/api/dashboard/inbound-holds?status=${status}&limit=500`, admin());
    expect(res.status).toBe(200);
    const body = await res.json();
    return (body.data as any[]).filter((h) => h.customerPhone === customerPhone);
  }

  const busFor = (customerPhone: string) =>
    bus.filter((e) => e.payload && (e.payload.sender === customerPhone || e.payload.recipient === customerPhone));

  async function consent(p: Party, phone: string) {
    return (await consentRecordRepository.findByRecipient(p.appSlug, p.tenantId, phone, 'sms'))?.status;
  }

  beforeAll(async () => {
    w = getWorld();
    worker = await w.startWorker();
    unsubscribe = w.runtime.bus.subscribe((e: TransactionEvent) => {
      bus.push(e);
    });
    // Registrations (through the real, tenant-authenticated gateway route).
    await registerNumber(w.reach, SHARED_MW, 'MW');
    await registerNumber(w.haulpro, SHARED_MW, 'MW');
    await registerNumber(w.haulpro, HAUL_ZM, 'ZM');
    await registerNumber(w.stayscape, SHARED_MW, 'MW');
    await registerNumber(w.reach, REACH_DED, 'MW', 'infobip');
  }, 60_000);

  afterAll(async () => {
    unsubscribe();
    if (worker) await stopWorker(worker);
  });

  describe('Scenario 1 — two tenants on one shared number, disambiguated by server-side destination data (not recency)', () => {
    it('outbound sends record the business number each conversation is actually on', async () => {
      const c = customer('ZM');
      expect((await send(w.reach, c, 'Sunday service at 9am')).status).toBe(200);
      expect((await send(w.haulpro, c, 'Your load is on the way')).status).toBe(200);
      const convs = await conversationRepository.findActiveByPhone(c);
      const byApp = Object.fromEntries(convs.map((x) => [x.appId, x.businessNumber]));
      // Reach has only the shared MW number; HaulPro sends to a Zambian
      // customer from its Zambian registration.
      expect(byApp[w.reach.appSlug]).toBe(SHARED_MW);
      expect(byApp[w.haulpro.appSlug]).toBe(HAUL_ZM);
    });

    it('a prayer request replying on the shared number reaches Reach Church — even though HaulPro messaged the customer more recently', async () => {
      const c = customer('ZM');
      expect((await send(w.reach, c, 'How can we pray for you this week?')).status).toBe(200);
      expect((await send(w.haulpro, c, 'Driver assigned')).status).toBe(200); // more recent
      const before = bus.length;

      await inbound(c, SHARED_MW, 'Please pray for my mother, she is in hospital');

      const rows = await w.eventsFor(c);
      const inboundRows = rows.filter((r) => String(r.decisionReason).startsWith('inbound_from_'));
      expect(inboundRows).toHaveLength(1);
      expect(inboundRows[0].appId).toBe(w.reach.appSlug);
      expect(inboundRows[0].payload.tenantId).toBe(w.reach.tenantId);
      expect(inboundRows[0].payload.businessNumber).toBe(SHARED_MW);
      // Nothing under HaulPro, and no bus event carrying the content to HaulPro.
      expect(rows.some((r) => r.appId === w.haulpro.appSlug)).toBe(false);
      const routed = bus.slice(before).filter((e) => String(e.decisionReason).startsWith('inbound_routed:'));
      expect(routed).toHaveLength(1);
      expect(routed[0].appId).toBe(w.reach.appSlug);
      expect(routed[0].tenantId).toBe(w.reach.tenantId);
      expect(bus.slice(before).some((e) => e.appId === w.haulpro.appSlug)).toBe(false);
      expect(await holdsFor(c)).toHaveLength(0);
    });

    it('the same customer replying on HaulPro\'s Zambian number reaches HaulPro', async () => {
      const c = customer('ZM');
      await send(w.haulpro, c, 'Delivery tomorrow?');
      await send(w.reach, c, 'Bible study tonight'); // more recent
      await inbound(c, HAUL_ZM, 'YES');
      const rows = await w.eventsFor(c);
      const yes = rows.filter((r) => r.decisionReason === 'keyword_yes');
      expect(yes).toHaveLength(1);
      expect(yes[0].appId).toBe(w.haulpro.appSlug);
      expect(rows.some((r) => r.appId === w.reach.appSlug && r.decisionReason === 'keyword_yes')).toBe(false);
    });

    it('a number dedicated to one tenant disambiguates even pre-Phase-8 conversations that never recorded a number', async () => {
      const c = customer('MW');
      // Emulate two legacy rows (no business number) on the same provider —
      // HaulPro's is the most recent. Pre-Phase-8 this was "ambiguous → HaulPro".
      await conversationRepository.upsert(c, w.reach.appSlug, { tenantId: w.reach.tenantId, providerId: 'infobip', channel: 'sms' });
      await new Promise((r) => setTimeout(r, 5));
      await conversationRepository.upsert(c, w.haulpro.appSlug, { tenantId: w.haulpro.tenantId, providerId: 'infobip', channel: 'sms' });

      await inbound(c, REACH_DED, 'Thank you pastor', 'infobip');

      const rows = await w.eventsFor(c);
      const inboundRows = rows.filter((r) => String(r.decisionReason).startsWith('inbound_from_'));
      expect(inboundRows.map((r) => r.appId)).toEqual([w.reach.appSlug]);
    });
  });

  describe('Scenario 2 — genuine ambiguity on a shared number: do not guess', () => {
    it('content is delivered to NO tenant, no keyword runs, nothing is dropped — it is held for an operator', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'Prayer meeting reminder');
      await send(w.haulpro, c, 'Your truck is booked'); // both on SHARED_MW; HaulPro newer
      const convs = await conversationRepository.findActiveByPhone(c);
      expect(convs.map((x) => x.businessNumber)).toEqual([SHARED_MW, SHARED_MW]);
      const before = bus.length;

      await inbound(c, SHARED_MW, 'Please pray for my mother, she is in hospital');

      // Delivered to nobody.
      expect(await w.eventsFor(c)).toHaveLength(0);
      const after = bus.slice(before);
      expect(after.some((e) => e.appId === w.reach.appSlug || e.appId === w.haulpro.appSlug)).toBe(false);
      // No TENANT-addressed event carries the content. (The gateway's own
      // pre-existing 'webhook_received' monitoring event, appId 'webhook',
      // no tenant, is admin-only and out of scope here.)
      const tenantAddressed = after.filter((e) => e.tenantId || [w.reach.appSlug, w.haulpro.appSlug, w.stayscape.appSlug].includes(e.appId));
      expect(tenantAddressed.some((e) => JSON.stringify(e.payload ?? {}).includes('pray for my mother'))).toBe(false);
      // Not dropped: one pending hold naming exactly the two plausible owners.
      const holds = await holdsFor(c);
      expect(holds).toHaveLength(1);
      expect(holds[0].reason).toBe('ambiguous_owner');
      expect(holds[0].businessNumber).toBe(SHARED_MW);
      expect(holds[0].content).toBe('Please pray for my mother, she is in hospital');
      expect(holds[0].candidates.map((x: any) => x.appId).sort()).toEqual([w.haulpro.appSlug, w.reach.appSlug].sort());
      // Operator signal is platform-level: no tenant, no content.
      const signal = after.find((e) => e.decisionReason === 'inbound_held:ambiguous_owner');
      expect(signal).toBeDefined();
      expect(signal!.tenantId).toBeUndefined();
      expect(signal!.appId).toBe('platform');
    });

    it('a webhook redelivery of the same message does not create a second hold', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'a');
      await send(w.haulpro, c, 'b');
      const body = buildInboundSms({ from: c, to: SHARED_MW, text: 'hello?' });
      expect((await deliverWebhook(w.runtime, 'signalhouse', body)).status).toBe(200);
      expect((await deliverWebhook(w.runtime, 'signalhouse', body)).status).toBe(200);
      await drain(worker, ['inbound_message']);
      expect(await holdsFor(c)).toHaveLength(1);
    });

    it('ambiguous YES / NO confirm nothing for any tenant', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'Can you volunteer Saturday? Reply YES/NO');
      await send(w.haulpro, c, 'Confirm pickup? Reply YES/NO');
      await inbound(c, SHARED_MW, 'YES');
      await inbound(c, SHARED_MW, 'NO');
      const rows = await w.eventsFor(c);
      expect(rows.filter((r) => r.decisionReason === 'keyword_yes' || r.decisionReason === 'keyword_no')).toHaveLength(0);
      expect(busFor(c).some((e) => String(e.decisionReason).startsWith('keyword_response:'))).toBe(false);
      expect((await holdsFor(c)).map((h) => h.keyword).sort()).toEqual(['NO', 'YES']);
    });

    it('a first message on the shared number from a customer with no conversation at all is held, not guessed', async () => {
      const c = customer('MW');
      await inbound(c, SHARED_MW, 'Hi, who is this?');
      expect(await w.eventsFor(c)).toHaveLength(0);
      const holds = await holdsFor(c);
      expect(holds).toHaveLength(1);
      expect(holds[0].reason).toBe('ambiguous_owner');
      expect(holds[0].candidates.length).toBe(3); // Reach, HaulPro, STAYSCAPE are all registered on it
    });

    it('an operator can only attribute a held message to one of its recorded candidates; it is then delivered to that owner only', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'x');
      await send(w.haulpro, c, 'y');
      await inbound(c, SHARED_MW, 'Please pray for my family');
      const [hold] = await holdsFor(c);

      // Not a candidate (STAYSCAPE has no conversation with this customer).
      const wrong = await w.runtime.post(
        `/api/dashboard/inbound-holds/${hold.id}/resolve`,
        { appId: w.stayscape.appSlug, tenantId: w.stayscape.tenantId, note: 'guess', resolvedBy: 'ops@bis' },
        admin(),
      );
      expect(wrong.status).toBe(409);
      // A tenant API key is not an operator.
      const tenantTry = await w.runtime.post(
        `/api/dashboard/inbound-holds/${hold.id}/resolve`,
        { appId: w.haulpro.appSlug, tenantId: w.haulpro.tenantId, note: 'mine', resolvedBy: 'haulpro' },
        auth(w.haulpro),
      );
      expect(tenantTry.status).toBe(403);
      expect(await w.eventsFor(c)).toHaveLength(0);

      const ok = await w.runtime.post(
        `/api/dashboard/inbound-holds/${hold.id}/resolve`,
        { appId: w.reach.appSlug, tenantId: w.reach.tenantId, note: 'customer confirmed by phone it was for the church', resolvedBy: 'ops@bis' },
        admin(),
      );
      expect(ok.status).toBe(200);
      await drain(worker, ['inbound_message']);

      const rows = await w.eventsFor(c);
      expect(rows.map((r) => r.appId)).toEqual([w.reach.appSlug]);
      expect(rows[0].payload.content).toBe('Please pray for my family');
      expect(rows[0].payload.holdId).toBe(hold.id);
      expect(await holdsFor(c, 'delivered')).toHaveLength(1);
      // Re-resolving a delivered hold is refused.
      const again = await w.runtime.post(
        `/api/dashboard/inbound-holds/${hold.id}/resolve`,
        { appId: w.haulpro.appSlug, tenantId: w.haulpro.tenantId, note: 'n', resolvedBy: 'ops@bis' },
        admin(),
      );
      expect(again.status).toBe(409);
    });
  });

  describe('Scenario 3 — STOP during ambiguity', () => {
    it('is never applied to a guessed tenant, never vanishes: recorded at the shared-number level and enforced', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'Weekly devotional');
      await send(w.haulpro, c, 'Rate your driver'); // HaulPro newest: the old resolver opted HaulPro out

      await inbound(c, SHARED_MW, 'STOP');

      // No tenant's consent changed — neither the guessed one nor any other.
      expect(await consent(w.reach, c)).toBeUndefined();
      expect(await consent(w.haulpro, c)).toBeUndefined();
      expect((await w.eventsFor(c)).some((r) => r.decisionReason === 'keyword_stop')).toBe(false);
      // Not vanished: durable hold + number-level opt-out.
      const [hold] = await holdsFor(c);
      expect(hold.keyword).toBe('STOP');
      expect(hold.senderOptOutApplied).toBe(true);
      const optOut = await senderOptOutRepository.find(SHARED_MW, c, 'sms');
      expect(optOut?.status).toBe('opted_out');
      expect(optOut?.holdId).toBe(hold.id);

      // Enforced for EVERY tenant sending from that number (carrier semantics).
      const reachSend = await send(w.reach, c, 'Are you still there?');
      const haulSend = await send(w.haulpro, c, 'Still need a truck?');
      expect(reachSend.status).toBe(403);
      expect(haulSend.status).toBe(403);
    });

    it('a STOP with no owner at all (unregistered number, no conversation) is still recorded, not dropped', async () => {
      const c = customer('MW');
      const unregistered = '+265991777777';
      await inbound(c, unregistered, 'STOP');
      const holds = await holdsFor(c);
      expect(holds).toHaveLength(1);
      expect(holds[0].reason).toBe('no_owner');
      expect((await senderOptOutRepository.find(unregistered, c, 'sms'))?.status).toBe('opted_out');
    });

    it('START on the shared number lifts only the number-level block; attribution then records the tenant-level opt-out for the attributed tenant only', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'r');
      await send(w.haulpro, c, 'h');
      await inbound(c, SHARED_MW, 'STOP');
      const [stopHold] = await holdsFor(c);

      // Operator learns the STOP was meant for HaulPro.
      const res = await w.runtime.post(
        `/api/dashboard/inbound-holds/${stopHold.id}/resolve`,
        { appId: w.haulpro.appSlug, tenantId: w.haulpro.tenantId, note: 'customer emailed: stop truck alerts', resolvedBy: 'ops@bis' },
        admin(),
      );
      expect(res.status).toBe(200);
      await drain(worker, ['inbound_message']);
      expect(await consent(w.haulpro, c)).toBe('opted_out');
      expect(await consent(w.reach, c)).toBeUndefined();

      // Customer texts START on the shared number (ambiguous again → held),
      // which clears the number-level block only.
      await inbound(c, SHARED_MW, 'START');
      expect((await senderOptOutRepository.find(SHARED_MW, c, 'sms'))?.status).toBe('opted_in');
      expect((await send(w.reach, c, 'Welcome back')).status).toBe(200);
      // HaulPro's own tenant-level opt-out is untouched by an ambiguous START.
      expect((await send(w.haulpro, c, 'Truck?')).status).toBe(403);
    });

    it('an unambiguous STOP on a shared number opts out that tenant AND mirrors the carrier\'s number-level block (A4)', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'Only Reach talks to this customer');
      await inbound(c, SHARED_MW, 'STOP');
      expect(await consent(w.reach, c)).toBe('opted_out');
      expect(await consent(w.haulpro, c)).toBeUndefined();
      expect((await senderOptOutRepository.find(SHARED_MW, c, 'sms'))?.status).toBe('opted_out');
      expect(await holdsFor(c)).toHaveLength(0);
      // The carrier would reject HaulPro's send from this number too; so does the platform.
      expect((await send(w.haulpro, c, 'hello')).status).toBe(403);
    });
  });

  describe('Scenario 4 — STAYSCAPE: two hotels sharing a number, a YES confirmation', () => {
    it('YES while both hotels have a booking conversation on the number confirms neither booking', async () => {
      const c = customer('MW');
      expect((await send(w.stayscape, c, 'Hotel Mangochi: confirm your 12 Dec booking? YES/NO', { supplierId: w.stayscape.hotelA })).status).toBe(200);
      expect((await send(w.stayscape, c, 'Hotel Salima: confirm your 20 Dec booking? YES/NO', { supplierId: w.stayscape.hotelB })).status).toBe(200);
      const convs = await conversationRepository.findActiveByPhone(c);
      expect(convs.map((x) => x.supplierId).sort()).toEqual([w.stayscape.hotelA, w.stayscape.hotelB].sort());
      expect(new Set(convs.map((x) => x.businessNumber))).toEqual(new Set([SHARED_MW]));

      await inbound(c, SHARED_MW, 'YES');

      expect((await w.eventsFor(c)).filter((r) => r.decisionReason === 'keyword_yes')).toHaveLength(0);
      const [hold] = await holdsFor(c);
      expect(hold.keyword).toBe('YES');
      expect(hold.candidates.map((x: any) => x.supplierId).sort()).toEqual([w.stayscape.hotelA, w.stayscape.hotelB].sort());

      // Attributed to Hotel Salima → the YES is recorded for Salima only.
      const res = await w.runtime.post(
        `/api/dashboard/inbound-holds/${hold.id}/resolve`,
        { appId: w.stayscape.appSlug, tenantId: w.stayscape.tenantId, supplierId: w.stayscape.hotelB, note: 'guest called Salima front desk', resolvedBy: 'ops@bis' },
        admin(),
      );
      expect(res.status).toBe(200);
      await drain(worker, ['inbound_message']);
      const yes = (await w.eventsFor(c)).filter((r) => r.decisionReason === 'keyword_yes');
      expect(yes).toHaveLength(1);
      expect(yes[0].payload.supplierId).toBe(w.stayscape.hotelB);
    });

    it('YES when only one hotel has a booking conversation with the customer goes to that hotel', async () => {
      const c = customer('MW');
      await send(w.stayscape, c, 'Hotel Salima: confirm? YES/NO', { supplierId: w.stayscape.hotelB });
      await inbound(c, SHARED_MW, 'YES');
      const yes = (await w.eventsFor(c)).filter((r) => r.decisionReason === 'keyword_yes');
      expect(yes).toHaveLength(1);
      expect(yes[0].appId).toBe(w.stayscape.appSlug);
      expect(yes[0].payload.supplierId).toBe(w.stayscape.hotelB);
      const response = busFor(c).find((e) => e.decisionReason === 'keyword_response:confirmation');
      expect(response?.supplierId).toBe(w.stayscape.hotelB);
      expect(response?.tenantId).toBe(w.stayscape.tenantId);
    });

    it('a hotel with its own dedicated number is identified by it (supplier-level profile)', async () => {
      const dedicatedA = '+265991000555';
      await registerNumber(w.stayscape, dedicatedA, 'MW', 'signalhouse', w.stayscape.hotelA);
      const c = customer('MW');
      await send(w.stayscape, c, 'Hotel Mangochi: confirm?', { supplierId: w.stayscape.hotelA });
      await send(w.stayscape, c, 'Hotel Salima: confirm?', { supplierId: w.stayscape.hotelB }); // newer
      const convs = await conversationRepository.findActiveByPhone(c);
      const numberBySupplier = Object.fromEntries(convs.map((x) => [x.supplierId, x.businessNumber]));
      expect(numberBySupplier[w.stayscape.hotelA]).toBe(dedicatedA);
      expect(numberBySupplier[w.stayscape.hotelB]).toBe(SHARED_MW);

      await inbound(c, dedicatedA, 'YES');
      const yes = (await w.eventsFor(c)).filter((r) => r.decisionReason === 'keyword_yes');
      expect(yes).toHaveLength(1);
      expect(yes[0].payload.supplierId).toBe(w.stayscape.hotelA);
    });
  });

  describe('Scenario 5 — the common single-tenant case still routes normally', () => {
    it('one conversation on a number only one tenant uses: routed, keyword handled, content delivered', async () => {
      const c = customer('MW');
      expect((await send(w.reach, c, 'Welcome to Reach Church', { provider: 'infobip' })).status).toBe(200);
      const [conv] = await conversationRepository.findActiveByPhone(c);
      expect(conv.businessNumber).toBe(REACH_DED);

      const started = Date.now();
      await inbound(c, REACH_DED, 'PRAY', 'infobip');
      await inbound(c, REACH_DED, 'See you on Sunday', 'infobip');
      const elapsed = Date.now() - started;

      const rows = await w.eventsFor(c);
      expect(rows.some((r) => r.decisionReason === 'keyword_prayer' && r.appId === w.reach.appSlug)).toBe(true);
      expect(rows.some((r) => String(r.decisionReason).startsWith('inbound_from_') && r.appId === w.reach.appSlug)).toBe(true);
      expect(await holdsFor(c)).toHaveLength(0);
      // Generous bound — two full webhook → queue → worker round trips.
      expect(elapsed).toBeLessThan(10_000);
    });

    it('a first message on a dedicated number opens a conversation for its only owner', async () => {
      const c = customer('MW');
      await inbound(c, REACH_DED, 'Hello, I saw your poster', 'infobip');
      const rows = await w.eventsFor(c);
      expect(rows.map((r) => r.appId)).toEqual([w.reach.appSlug]);
      const [conv] = await conversationRepository.findActiveByPhone(c);
      expect(conv.appId).toBe(w.reach.appSlug);
      expect(conv.businessNumber).toBe(REACH_DED);
      expect(conv.messagingProfileId).toBeTruthy();
    });

    it('an unambiguous STOP on a dedicated number opts out that tenant only (unchanged behaviour)', async () => {
      const c = customer('MW');
      await send(w.reach, c, 'Hi', { provider: 'infobip' });
      await inbound(c, REACH_DED, 'STOP', 'infobip');
      expect(await consent(w.reach, c)).toBe('opted_out');
      expect(await senderOptOutRepository.find(REACH_DED, c, 'sms')).toBeUndefined();
      expect((await send(w.reach, c, 'still there?', { provider: 'infobip' })).status).toBe(403);
    });
  });
}
