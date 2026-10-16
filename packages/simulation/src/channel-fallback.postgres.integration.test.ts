import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/**
 * Phase 10 — channel decisions observable AND auditable, on a REAL
 * PostgreSQL migrated from zero (including migration 0019), through the REAL
 * gateway and REAL worker. The ONLY substitution is connection.ts's getDb().
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/simulation/src/channel-fallback.postgres.integration.test.ts
 *
 * Skipped when TEST_POSTGRES_URL is unset.
 */

const pg = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../../database/src/connection', () => ({
  getDb: () => {
    if (!pg.db) throw new Error('channel-fallback test database not initialised');
    return pg.db;
  },
  getRawSql: () => {
    throw new Error('getRawSql is not available in the postgres test harness');
  },
  checkDatabaseHealth: async () => ({ status: 'healthy', latencyMs: 0, details: {} }),
  schema: {},
}));

import {
  createMigratedTestDatabase,
  createPartiallyMigratedTestDatabase,
  type MigratedTestDatabase,
} from '../../database/src/test-utils/postgres-test-db';
import {
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
  tenantRepository,
  tenantApplicationLinkRepository,
} from '@company/database';
import { createSimulation, stopWorker, waitFor, type SimRuntime, type WorkerHandle } from './harness';

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const SMS_CAPABLE = ['signalhouse', 'infobip', 'futuresms', 'example-msg', 'africastalking', 'sinch', 'vibes', 'twilio', 'vonage'];

describe.skipIf(!ADMIN_URL)('Phase 10 — channel decision audit (real PostgreSQL)', () => {
  let database: MigratedTestDatabase;
  let runtime: SimRuntime;
  let worker: WorkerHandle;
  let party: { appSlug: string; apiKey: string; tenantId: string };
  const auth = () => ({ authorization: `Bearer ${party.apiKey}`, 'x-tenant-id': party.tenantId });

  beforeAll(async () => {
    database = await createMigratedTestDatabase(ADMIN_URL!, 'bis_p10');
    pg.db = database.db;
    runtime = await createSimulation();
    const suffix = randomBytes(3).toString('hex');
    const created = await new ApplicationRegistry(applicationRepository, apiKeyRepository).createApplication({
      name: `Reach Church ${suffix}`,
      slug: `reach-church-${suffix}`,
    });
    const tenant = await tenantRepository.create({ name: 'Grace Congregation', slug: `grace-${suffix}` });
    await tenantApplicationLinkRepository.link(tenant.id, created.application.id);
    party = { appSlug: created.application.slug, apiKey: created.apiKey.raw, tenantId: tenant.id };
    worker = await runtime.makeWorker({});
  }, 60_000);

  afterAll(async () => {
    if (worker) await stopWorker(worker);
    await runtime?.close();
    await database?.drop();
  }, 30_000);

  afterEach(() => {
    for (const id of [...SMS_CAPABLE, 'whatsapp', 'email']) runtime.registry.updateManagement(id, { status: 'online' });
  });

  async function post(pathname: string, body: unknown) {
    const res = await runtime.post(pathname, body, { 'content-type': 'application/json', ...auth() });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('migration 0019 upgrades a database already at 0018 without touching existing events', async () => {
    // 18 = journal idx of 0018_keyword_commands, the migration before 0019.
    const upgrade = await createPartiallyMigratedTestDatabase(ADMIN_URL!, 18, 'bis_p10up');
    try {
      const { client } = upgrade;
      const before = await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'fallback_reason'`;
      expect(before).toHaveLength(0);
      await client`INSERT INTO events (app_id, category, provider_id, status, decision_reason)
                   VALUES ('system', 'messaging', 'email', 'success', 'Defaulted to first available messaging channel: ''Email SMTP''.')`;
      await upgrade.migrateRest();
      const rows = await client`SELECT provider_id, decision_reason, requested_channel, selected_channel, fallback_reason FROM events`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider_id: 'email', requested_channel: null, selected_channel: null, fallback_reason: null });
    } finally {
      await upgrade.drop();
    }
  });

  it('chk_events_channel_fallback_reason: a silent channel change cannot be recorded', async () => {
    const insert = (requested: string | null, selected: string | null, reason: string | null) =>
      database.client`INSERT INTO events (app_id, category, status, requested_channel, selected_channel, fallback_reason)
                      VALUES ('system', 'messaging', 'success', ${requested}, ${selected}, ${reason})`;
    // Rejected: channel changed with no reason / a blank reason; reason given for no change.
    await expect(insert('sms', 'email', null)).rejects.toThrow(/chk_events_channel_fallback_reason/);
    await expect(insert('sms', 'email', '   ')).rejects.toThrow(/chk_events_channel_fallback_reason/);
    await expect(insert('sms', 'sms', 'no change happened')).rejects.toThrow(/chk_events_channel_fallback_reason/);
    // Accepted.
    await insert('sms', 'sms', null);
    await insert('sms', 'email', "Requested channel 'sms' unavailable: ...");
    await insert('sms', null, null); // a failure: nothing was sent
    await insert(null, null, null); // non-messaging / pre-0019 shape
  });

  it('explicit sms + SMS down + no opt-in → 503 specific failure, nothing sent on email', async () => {
    for (const id of SMS_CAPABLE) runtime.registry.updateManagement(id, { status: 'offline' });
    const res = await post('/v1/api/gateway/messaging', { recipient: '+15557790001', content: 'x', channel: 'sms' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'channel_unavailable', requestedChannel: 'sms', selectedChannel: null, fallbackReason: null });
    const convs = await database.client`SELECT channel FROM conversations WHERE phone_number = '+15557790001'`;
    expect(convs).toHaveLength(0);
  });

  it('gateway: opted-in SMS → email fallback uses the real consent_records opt-in, and is not sticky', async () => {
    const phone = '+15557790002';
    const email = 'p10-pg@reachchurch.example';
    expect((await post('/v1/api/consent', { recipient: email, channel: 'email', status: 'opted_in' })).status).toBe(200);
    const policy = { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email } };

    for (const id of SMS_CAPABLE) runtime.registry.updateManagement(id, { status: 'offline' });
    const first = await post('/v1/api/gateway/messaging', { recipient: phone, content: 'a', channel: 'sms', channelPolicy: policy });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ providerId: 'email', requestedChannel: 'sms', selectedChannel: 'email' });
    expect(String(first.body.fallbackReason)).toContain("Requested channel 'sms' unavailable");

    for (const id of SMS_CAPABLE) runtime.registry.updateManagement(id, { status: 'online' });
    const second = await post('/v1/api/gateway/messaging', { recipient: phone, content: 'b', channel: 'sms', channelPolicy: policy });
    expect(second.status).toBe(200);
    expect(SMS_CAPABLE).toContain(second.body.providerId);
    expect(second.body).toMatchObject({ selectedChannel: 'sms', fallbackReason: null });

    const convs = await database.client`
      SELECT phone_number, channel, provider_id FROM conversations WHERE phone_number IN (${phone}, ${email}) ORDER BY channel`;
    expect(convs.map((c) => [c.phone_number, c.channel])).toEqual([
      [email, 'email'],
      [phone, 'sms'],
    ]);
  });

  it('worker durable path: message_delivery writes the channel decision to the events row', async () => {
    const email = 'p10-worker@reachchurch.example';
    expect((await post('/v1/api/consent', { recipient: email, channel: 'email', status: 'opted_in' })).status).toBe(200);

    // 1. no fallback: requested = selected, reason NULL
    const plain = await worker.queue.enqueue('message_delivery', {
      appId: party.appSlug, tenantId: party.tenantId, recipient: '+15557790003', content: 'plain', channel: 'sms',
    });
    await waitFor(async () => (await worker.queue.getJob(plain.id))?.status === 'completed', { label: 'plain message_delivery' });

    // 2. opted-in fallback: SMS down → email, reason recorded
    for (const id of SMS_CAPABLE) runtime.registry.updateManagement(id, { status: 'offline' });
    const fb = await worker.queue.enqueue('message_delivery', {
      appId: party.appSlug,
      tenantId: party.tenantId,
      recipient: '+15557790004',
      content: 'fallback',
      channel: 'sms',
      channelPolicy: { allowChannelSwitch: true, fallbackChannels: ['email'], fallbackRecipients: { email } },
    });
    await waitFor(async () => (await worker.queue.getJob(fb.id))?.status === 'completed', { label: 'fallback message_delivery' });

    const rows = await database.client`
      SELECT provider_id, requested_channel, selected_channel, fallback_reason, payload->>'recipient' AS recipient
      FROM events WHERE app_id = ${party.appSlug} AND category = 'messaging' ORDER BY created_at`;
    const plainRow = rows.find((r) => r.recipient === '+15557790003');
    const fbRow = rows.find((r) => r.recipient === email);
    expect(plainRow).toMatchObject({ requested_channel: 'sms', selected_channel: 'sms', fallback_reason: null });
    expect(fbRow).toMatchObject({ provider_id: 'email', requested_channel: 'sms', selected_channel: 'email' });
    expect(String(fbRow!.fallback_reason)).toContain("Sent on fallback channel 'email' to " + email);

    // The audit query migration 0019's partial index serves.
    const switched = await database.client`
      SELECT requested_channel, selected_channel FROM events
      WHERE app_id = ${party.appSlug} AND fallback_reason IS NOT NULL`;
    expect(switched).toEqual([{ requested_channel: 'sms', selected_channel: 'email' }]);
  });
});
