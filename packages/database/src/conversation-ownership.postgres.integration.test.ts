import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Phase 8 — database-level proof for shared-phone-number conversation
 * ownership (gap register A1/D12, A15, A4), against a REAL PostgreSQL:
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/conversation-ownership.postgres.integration.test.ts
 *
 *  - migration 0017 on a database already at 0016 WITH legacy data: nothing
 *    deleted or merged, addresses normalised only where collision-free, the
 *    new ownership key in force and the old one gone;
 *  - the ownership key itself (NULLS NOT DISTINCT) enforced by Postgres;
 *  - the production repositories (conversations, inbound holds, sender
 *    opt-outs) under real concurrency on a 10-connection pool.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');

const pg = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('./connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('not available');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy' }),
}));

import { conversationRepository } from './repositories/conversations';
import { inboundMessageHoldRepository, senderOptOutRepository } from './repositories/inbound-routing';
import { messagingProfileRepository } from './repositories/messaging-profiles';

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function migrationsThrough(lastIdx: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bis-drizzle-p8-'));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe.skipIf(!ADMIN_URL)('Phase 8 — conversation ownership on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const clients: Array<ReturnType<typeof postgres>> = [];

  async function freshDb() {
    const name = `bis_p8db_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
    const client = postgres(urlFor(name), { max: 10, onnotice: () => {} });
    clients.push(client);
    return { name, client, db: drizzle(client) };
  }

  let main: Awaited<ReturnType<typeof freshDb>>;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    main = await freshDb();
    await migrate(main.db, { migrationsFolder: MIGRATIONS });
    pg.db = main.db;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  describe('migration 0017', () => {
    it('applies to a database already at 0016 with legacy data: nothing deleted/merged, safe normalisation only, new key in force, old key gone', async () => {
      const { client, db } = await freshDb();
      await migrate(db, { migrationsFolder: migrationsThrough(16) });
      // Legacy rows. Two of them normalise to the SAME number for the same
      // owner — those must be left exactly as they are (no merge, no loss).
      await client`INSERT INTO conversations (phone_number, app_id, tenant_id, provider_id, channel) VALUES
        ('+265 88 123 4567', 'reach', 't1', 'signalhouse', 'sms'),
        ('+1 (555) 010-0001', 'reach', 't1', 'signalhouse', 'sms'),
        ('+15550100001', 'reach', 't1', 'signalhouse', 'sms'),
        ('+15550100001', 'haulpro', 't2', 'signalhouse', 'sms')`;
      await client`INSERT INTO messaging_profiles (app_id, tenant_id, country, sender_type, sender, provider) VALUES
        ('reach', 't1', 'MW', 'phone', 'whatsapp:+265 991 000 001', 'signalhouse'),
        ('reach', 't1', 'GB', 'alphanumeric', 'Reach Church', 'vonage')`;

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const convs = await client`SELECT phone_number, app_id, business_number, supplier_id FROM conversations ORDER BY app_id, phone_number`;
      expect(convs).toHaveLength(4);
      expect(convs.map((r) => r.phone_number)).toEqual(['+15550100001', '+1 (555) 010-0001', '+15550100001', '+265881234567']);
      expect(convs.every((r) => r.business_number === null && r.supplier_id === null)).toBe(true);
      const senders = (await client`SELECT sender FROM messaging_profiles ORDER BY sender`).map((r) => r.sender);
      expect(senders).toEqual(['+265991000001', 'Reach Church']);

      const [{ old_idx }] = await client`SELECT count(*)::int AS old_idx FROM pg_indexes WHERE indexname = 'idx_conversations_phone_app_tenant'`;
      expect(old_idx).toBe(0);
      const [{ def }] = await client`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'uq_conversations_owner'`;
      expect(def).toBe('UNIQUE NULLS NOT DISTINCT (phone_number, business_number, app_id, tenant_id, supplier_id)');
    });

    it('the ownership key: same customer on one shared number with two tenants / two suppliers = distinct rows; a duplicate owner (incl. NULLs) is rejected', async () => {
      const ins = (phone: string, biz: string | null, app: string, tenant: string, supplier: string | null) =>
        main.client`INSERT INTO conversations (phone_number, business_number, app_id, tenant_id, supplier_id, provider_id, channel)
                    VALUES (${phone}, ${biz}, ${app}, ${tenant}, ${supplier}, 'signalhouse', 'sms')`;
      const c = '+265880000001';
      const S = '+265991000001';
      await ins(c, S, 'reach', 't1', null);
      await ins(c, S, 'haulpro', 't2', null);
      await ins(c, S, 'stayscape', 't3', 'hotel-a');
      await ins(c, S, 'stayscape', 't3', 'hotel-b');
      await ins(c, '+260971000002', 'haulpro', 't2', null);
      await ins(c, null, 'reach', 't1', null);
      for (const dup of [
        () => ins(c, S, 'reach', 't1', null),
        () => ins(c, null, 'reach', 't1', null),
        () => ins(c, S, 'stayscape', 't3', 'hotel-a'),
      ]) {
        const err = await dup().then(() => null, (e: { code?: string; constraint_name?: string }) => e);
        expect(err?.code).toBe('23505');
        expect(err?.constraint_name).toBe('uq_conversations_owner');
      }
    });
  });

  describe('conversationRepository', () => {
    it('20 concurrent first sends for one owner/number produce exactly one row (gap register A15 race)', async () => {
      const c = '+265880000002';
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          conversationRepository.upsert(c, 'reach', { tenantId: 't1', providerId: 'signalhouse', channel: 'sms', businessNumber: '+265991000001' }),
        ),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
      expect(ids.size).toBe(1);
      const [{ n }] = await main.client`SELECT count(*)::int AS n FROM conversations WHERE phone_number = ${c}`;
      expect(n).toBe(1);
    });

    it('an owner\'s legacy (unnumbered) thread is adopted by its first numbered send instead of forking; other owners are never touched', async () => {
      const c = '+265880000003';
      const legacyReach = await conversationRepository.upsert(c, 'reach', { tenantId: 't1', providerId: 'signalhouse', channel: 'sms' });
      const legacyHaul = await conversationRepository.upsert(c, 'haulpro', { tenantId: 't2', providerId: 'signalhouse', channel: 'sms' });
      expect(legacyReach.businessNumber).toBeNull();
      const numbered = await conversationRepository.upsert(c, 'reach', {
        tenantId: 't1', providerId: 'signalhouse', channel: 'sms', businessNumber: '+265 991 000 001',
      });
      expect(numbered.id).toBe(legacyReach.id);
      expect(numbered.businessNumber).toBe('+265991000001');
      const all = await conversationRepository.findActiveByPhone(c);
      expect(all).toHaveLength(2);
      expect(all.find((x) => x.id === legacyHaul.id)?.businessNumber).toBeNull();
    });

    it('stores and finds the customer number in canonical form', async () => {
      await conversationRepository.upsert('whatsapp:+265 88 000 0004', 'reach', { tenantId: 't1', providerId: 'signalhouse', channel: 'whatsapp' });
      expect(await conversationRepository.findActiveByPhone('+265880000004')).toHaveLength(1);
      expect(await conversationRepository.findByPhoneAndApp('+265 (88) 000-0004', 'reach', 't1')).toBeDefined();
    });
  });

  describe('messagingProfileRepository (destination → owners)', () => {
    it('finds every owner registered on a destination number for a provider, in deterministic order', async () => {
      const S = '+265991000777';
      await messagingProfileRepository.create({ appId: 'reach', tenantId: 't1', country: 'MW', senderType: 'phone', sender: '+265 991 000 777', provider: 'signalhouse' });
      await messagingProfileRepository.create({ appId: 'haulpro', tenantId: 't2', country: 'MW', senderType: 'phone', sender: S, provider: 'signalhouse' });
      await messagingProfileRepository.create({ appId: 'stayscape', tenantId: 't3', country: 'MW', senderType: 'phone', sender: S, provider: 'signalhouse', supplierId: 'hotel-a' });
      await messagingProfileRepository.create({ appId: 'other', tenantId: 't4', country: 'MW', senderType: 'phone', sender: S, provider: 'infobip' });
      const owners = await messagingProfileRepository.findOwnersOfSender('whatsapp:+265991000777', 'signalhouse');
      expect(owners.map((o) => o.appId).sort()).toEqual(['haulpro', 'reach', 'stayscape']);
      expect(owners.find((o) => o.appId === 'stayscape')?.supplierId).toBe('hotel-a');
      expect(owners.map((o) => o.id)).toEqual([...owners.map((o) => o.id)].sort());
    });
  });

  describe('inboundMessageHoldRepository', () => {
    const base = (dedupeKey: string) => ({
      dedupeKey,
      providerId: 'signalhouse',
      customerPhone: '+265880000010',
      businessNumber: '+265991000001',
      channel: 'sms',
      content: 'STOP',
      keyword: 'STOP',
      reason: 'ambiguous_owner' as const,
      candidates: [
        { appId: 'haulpro', tenantId: 't2', supplierId: null, conversationId: null },
        { appId: 'reach', tenantId: 't1', supplierId: null, conversationId: null },
      ],
    });

    it('10 concurrent deliveries of the same inbound message create exactly one hold', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => inboundMessageHoldRepository.createOrGet(base('dup-1'))));
      expect(new Set(results.map((r) => r.hold.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });

    it('attribution: only to a recorded candidate; two operators racing → exactly one wins; delivered exactly once', async () => {
      const { hold } = await inboundMessageHoldRepository.createOrGet(base('race-1'));
      const notCandidate = await inboundMessageHoldRepository.resolve(hold.id, { appId: 'stayscape', tenantId: 't3' }, { resolvedBy: 'x', note: 'y' });
      expect(notCandidate.outcome).toBe('not_a_candidate');

      const [a, b] = await Promise.all([
        inboundMessageHoldRepository.resolve(hold.id, { appId: 'reach', tenantId: 't1' }, { resolvedBy: 'op-a', note: 'a' }),
        inboundMessageHoldRepository.resolve(hold.id, { appId: 'haulpro', tenantId: 't2' }, { resolvedBy: 'op-b', note: 'b' }),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(['not_pending', 'resolved']);
      const winner = a.outcome === 'resolved' ? 'reach' : 'haulpro';
      const row = await inboundMessageHoldRepository.findById(hold.id);
      expect(row?.resolvedAppId).toBe(winner);

      const delivered = await Promise.all([inboundMessageHoldRepository.markDelivered(hold.id), inboundMessageHoldRepository.markDelivered(hold.id)]);
      expect(delivered.filter(Boolean)).toHaveLength(1);
    });

    it('Postgres rejects a status or reason outside the defined sets', async () => {
      const err = await main.client`
        INSERT INTO inbound_message_holds (dedupe_key, provider_id, customer_phone, content, reason, status)
        VALUES ('bad', 'p', '+1', 'x', 'ambiguous_owner', 'guessed')`.then(() => null, (e: { code?: string }) => e);
      expect(err?.code).toBe('23514');
    });
  });

  describe('senderOptOutRepository', () => {
    it('records and lifts a number-level opt-out idempotently (canonical addresses)', async () => {
      const row = await senderOptOutRepository.upsert({
        businessNumber: '+265 991 000 001', recipient: 'whatsapp:+265 88 000 0020', channel: 'sms', status: 'opted_out', source: 'keyword_held', keyword: 'STOP',
      });
      expect(row.businessNumber).toBe('+265991000001');
      expect(await senderOptOutRepository.isOptedOut('+265991000001', '+265880000020', 'sms')).toBe(true);
      await senderOptOutRepository.upsert({
        businessNumber: '+265991000001', recipient: '+265880000020', channel: 'sms', status: 'opted_in', source: 'keyword_held', keyword: 'JOIN',
      });
      expect(await senderOptOutRepository.isOptedOut('+265991000001', '+265880000020', 'sms')).toBe(false);
      const [{ n }] = await main.client`SELECT count(*)::int AS n FROM sender_opt_outs WHERE recipient = '+265880000020'`;
      expect(n).toBe(1);
    });
  });
});
