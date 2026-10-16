import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createWebhookEventRepository, type WebhookEventClaimInput } from './repositories/webhook-events';

/**
 * Phase 4 proof against a REAL PostgreSQL server (not Neon-HTTP, not a mock):
 * the durable inbound-webhook identity (gap register D7) and the per-consumer
 * processing state that replaces the stuck replay marker (B5).
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/webhook-events.postgres.integration.test.ts
 *
 * Fresh database, migrated FROM ZERO with drizzle's own migrator over this
 * repo's drizzle/ folder, dropped afterwards. Production repository code,
 * postgres-js handle (same PgDialect / SQL as neon-http).
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');

function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!ADMIN_URL)('Phase 4 — durable webhook identity on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  const created: string[] = [];
  const clients: Array<ReturnType<typeof postgres>> = [];
  let main: { client: ReturnType<typeof postgres>; db: PostgresJsDatabase; url: string };
  let repo: ReturnType<typeof createWebhookEventRepository>;

  async function freshDb() {
    const name = `bis_p4_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
    const url = urlFor(name);
    const client = postgres(url, { max: 10, onnotice: () => {} });
    clients.push(client);
    return { name, url, client, db: drizzle(client) };
  }

  function connect(url: string, max = 4) {
    const client = postgres(url, { max, onnotice: () => {} });
    clients.push(client);
    return { client, db: drizzle(client) };
  }

  /** An independent repository with its OWN connection pool (a separate "replica"/"process"). */
  function replicaRepo(max = 5) {
    const { db } = connect(main.url, max);
    return createWebhookEventRepository(() => db as never);
  }

  /** drizzle wraps driver errors ("Failed query: ..."); the Postgres SQLSTATE is on the cause. */
  const pgCode = (e: unknown): string | undefined => {
    const err = e as { code?: string; cause?: { code?: string } } | null;
    return err?.code ?? err?.cause?.code;
  };

  function migrationsThrough(lastIdx: number): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bis-drizzle-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
    writeFileSync(journalPath, JSON.stringify(journal));
    return dir;
  }

  const input = (providerEventId: string, over: Partial<WebhookEventClaimInput> = {}): WebhookEventClaimInput => ({
    providerId: 'stripe',
    providerEventId,
    appId: 'webhook',
    tenantId: null,
    eventType: 'charge.succeeded',
    payload: { id: providerEventId, type: 'charge.succeeded' },
    rawBody: JSON.stringify({ id: providerEventId, type: 'charge.succeeded' }),
    signature: 'deadbeef',
    expectedConsumers: ['payment_webhook', 'provider_webhook'],
    enqueueLeaseMs: 30_000,
    ...over,
  });

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    main = await freshDb();
    await migrate(main.db, { migrationsFolder: MIGRATIONS });
    repo = createWebhookEventRepository(() => main.db as never);
  });

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // The constraint itself (migration 0014, from zero)
  // -------------------------------------------------------------------------
  describe('migration 0014 (from zero, real drizzle migrator)', () => {
    it('creates uq_webhook_events_provider_event as a UNIQUE index on (provider_id, provider_event_id)', async () => {
      const rows = await main.client`
        SELECT i.indisunique AS unique, array_agg(a.attname ORDER BY k.ord) AS cols
        FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE c.relname = 'uq_webhook_events_provider_event'
        GROUP BY i.indisunique`;
      expect(rows).toHaveLength(1);
      expect(rows[0].unique).toBe(true);
      expect(rows[0].cols).toEqual(['provider_id', 'provider_event_id']);
    });

    it('Postgres itself rejects a literal duplicate (provider_id, provider_event_id) INSERT with 23505', async () => {
      const insert = (provider: string) => main.client`
        INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body)
        VALUES (${provider}, 'evt_literal_dup', '{}'::jsonb, '{}')`;
      await insert('stripe');
      const err = await insert('stripe').then(
        () => null,
        (e: unknown) => e as { code?: string; constraint_name?: string },
      );
      expect(err?.code).toBe('23505');
      expect(err?.constraint_name).toBe('uq_webhook_events_provider_event');
      // Same event id from a DIFFERENT provider is a different event (the old
      // in-memory map keyed on body.id alone would have collided here).
      await insert('paystack');
    });

    it('provider_event_id is mandatory: NULL → 23502, empty → 23514 (the durable identity minimum)', async () => {
      const nullErr = await main.client`
        INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body)
        VALUES ('stripe', NULL, '{}'::jsonb, '{}')`.then(() => null, (e: { code?: string }) => e);
      expect(nullErr?.code).toBe('23502');
      const emptyErr = await main.client`
        INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body)
        VALUES ('stripe', '', '{}'::jsonb, '{}')`.then(() => null, (e: { code?: string }) => e);
      expect(emptyErr?.code).toBe('23514');
      const statusErr = await main.client`
        INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body, status)
        VALUES ('stripe', 'evt_bad_status', '{}'::jsonb, '{}', 'bogus')`.then(() => null, (e: { code?: string }) => e);
      expect(statusErr?.code).toBe('23514');
    });

    it('is applied to a database that was ALREADY migrated through 0013 (journal ordering)', async () => {
      const { client, db } = await freshDb();
      const through13 = migrationsThrough(13);
      try {
        await migrate(db, { migrationsFolder: through13 });
        const before = await client`SELECT 1 FROM pg_tables WHERE tablename = 'webhook_events'`;
        expect(before).toHaveLength(0);
        await migrate(db, { migrationsFolder: MIGRATIONS });
        const after = await client`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_webhook_events_provider_event'`;
        expect(after).toHaveLength(1);
        const evIdx = await client`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_idempotency_key'`;
        expect(evIdx).toHaveLength(1);
      } finally {
        rmSync(through13, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // The atomic claim — the uniqueness enforcement point
  // -------------------------------------------------------------------------
  describe('webhookEventRepository.claim (INSERT ... ON CONFLICT DO NOTHING RETURNING)', () => {
    it('first delivery is claimed; a sequential duplicate is not, and gets the original row back', async () => {
      const first = await repo.claim(input('evt_seq'));
      expect(first.claimed).toBe(true);
      const second = await repo.claim(input('evt_seq', { payload: { different: true } }));
      expect(second.claimed).toBe(false);
      if (first.claimed && !second.claimed) {
        expect(second.existing?.id).toBe(first.event.id);
        expect(second.existing?.payload).toEqual({ id: 'evt_seq', type: 'charge.succeeded' }); // first write wins
      }
    });

    it('25 truly concurrent duplicate deliveries over 5 independent connection pools ("replicas"): exactly one row, exactly one winner', async () => {
      const replicas = Array.from({ length: 5 }, () => replicaRepo(5));
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => replicas[i % replicas.length].claim(input('evt_race'))),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      const winnerId = results.find((r) => r.claimed && r.event)!;
      for (const r of results.filter((x) => !x.claimed)) {
        expect(r.claimed === false && r.existing?.id).toBe(winnerId.claimed && winnerId.event.id);
      }
      const [{ n }] = await main.client`
        SELECT count(*)::int AS n FROM webhook_events WHERE provider_id = 'stripe' AND provider_event_id = 'evt_race'`;
      expect(n).toBe(1);
    });

    it('negative control — the claim relies on the DB constraint: without the unique index the claim cannot even run, and plain inserts duplicate', async () => {
      // Negative control proving the index — not application code — is the
      // enforcement mechanism. Uses its own throwaway database.
      const { client, db } = await freshDb();
      await migrate(db, { migrationsFolder: MIGRATIONS });
      await client`DROP INDEX uq_webhook_events_provider_event`;
      // ON CONFLICT (cols) needs a matching unique index to even parse, so a
      // repository without it errors out instead of silently de-duplicating.
      const r = createWebhookEventRepository(() => db as never);
      const err = await r.claim(input('evt_no_index')).then(() => null, (e: unknown) => e);
      expect(pgCode(err)).toBe('42P10'); // no unique constraint matching the ON CONFLICT spec
      // And plain inserts now happily duplicate.
      await client`INSERT INTO webhook_events (provider_id, provider_event_id, payload, raw_body) VALUES ('stripe','x','{}'::jsonb,'{}'), ('stripe','x','{}'::jsonb,'{}')`;
      const [{ n }] = await client`SELECT count(*)::int AS n FROM webhook_events WHERE provider_event_id = 'x'`;
      expect(n).toBe(2);
    });

    it('a "restarted" process (brand-new connection pool, no shared memory) still sees the duplicate', async () => {
      const before = await repo.claim(input('evt_restart'));
      expect(before.claimed).toBe(true);
      const restarted = replicaRepo(2);
      const after = await restarted.claim(input('evt_restart'));
      expect(after.claimed).toBe(false);
      if (before.claimed && !after.claimed) expect(after.existing?.id).toBe(before.event.id);
    });
  });

  // -------------------------------------------------------------------------
  // Enqueue lease (gateway takeover + recovery sweeper)
  // -------------------------------------------------------------------------
  describe('enqueue lease', () => {
    it('the inserting caller holds the lease; nobody can take it over until it is released or lapses', async () => {
      const c = await repo.claim(input('evt_lease'));
      if (!c.claimed) throw new Error('expected claim');
      expect(await repo.acquireEnqueueLease(c.event.id, 30_000)).toBeUndefined();
      await repo.releaseEnqueueLease(c.event.id, ['inbound_message'], 'enqueue payment_webhook failed: boom');
      const concurrent = await Promise.all(Array.from({ length: 10 }, () => repo.acquireEnqueueLease(c.event.id, 30_000)));
      expect(concurrent.filter(Boolean)).toHaveLength(1);
      expect(concurrent.find(Boolean)!.enqueuedJobs).toEqual(['inbound_message']);
      await repo.markEnqueued(c.event.id, ['inbound_message', 'payment_webhook', 'provider_webhook']);
      expect(await repo.acquireEnqueueLease(c.event.id, 0)).toBeUndefined(); // already enqueued
    });

    it('claimStrandedForEnqueue leases never-enqueued rows (lapsed lease) and stale still-received rows, once', async () => {
      const lapsed = await repo.claim(input('evt_stranded_a', { enqueueLeaseMs: 0 }));
      const held = await repo.claim(input('evt_stranded_b', { enqueueLeaseMs: 60_000 }));
      const stale = await repo.claim(input('evt_stranded_c', { enqueueLeaseMs: 0 }));
      if (!lapsed.claimed || !held.claimed || !stale.claimed) throw new Error('expected claims');
      await repo.markEnqueued(stale.event.id, ['payment_webhook']);
      await main.client`UPDATE webhook_events SET enqueued_at = now() - interval '1 hour' WHERE id = ${stale.event.id}`;

      // A row whose only consumer is handled inline (e.g. billing) is never swept.
      await repo.claim(input('evt_stranded_inline', { enqueueLeaseMs: 0, expectedConsumers: ['billing_sync'] }));
      const opts = { limit: 100, leaseMs: 30_000, staleAfterMs: 10 * 60_000, consumers: ['payment_webhook', 'provider_webhook'] };
      const [a, b] = await Promise.all([repo.claimStrandedForEnqueue(opts), repo.claimStrandedForEnqueue(opts)]);
      const ids = [...a, ...b].map((r) => r.providerEventId).filter((id) => id.startsWith('evt_stranded_'));
      expect(ids.sort()).toEqual(['evt_stranded_a', 'evt_stranded_c']); // each exactly once, held one untouched
    });
  });

  // -------------------------------------------------------------------------
  // Per-consumer processing state — the B5 fix
  // -------------------------------------------------------------------------
  describe('consumer claims (webhook_event_consumers)', () => {
    it('failed attempt → clean re-claim → processed; only then is it a replay', async () => {
      const c = await repo.claim(input('evt_consumer'));
      if (!c.claimed) throw new Error('expected claim');
      const id = c.event.id;

      const a1 = await repo.claimConsumer(id, 'payment_webhook', 60_000);
      expect(a1.claimed).toBe(true);
      if (!a1.claimed) return;
      expect((await repo.findById(id))!.status).toBe('processing');
      expect(await repo.failConsumer(id, 'payment_webhook', a1.consumer.claimToken, 'db write failed')).toBe(true);
      expect((await repo.findById(id))!.status).toBe('failed');

      // B5: the retry is NOT locked out.
      const a2 = await repo.claimConsumer(id, 'payment_webhook', 60_000);
      expect(a2.claimed).toBe(true);
      if (!a2.claimed) return;
      expect(a2.consumer.attempts).toBe(2);
      expect(a2.consumer.claimToken).not.toBe(a1.consumer.claimToken);
      // A stale token from attempt 1 cannot complete attempt 2's claim (fencing).
      expect(await repo.completeConsumer(id, 'payment_webhook', a1.consumer.claimToken)).toBe(false);
      expect(await repo.completeConsumer(id, 'payment_webhook', a2.consumer.claimToken)).toBe(true);
      // One of two expected consumers done → event not yet processed.
      expect((await repo.findById(id))!.status).not.toBe('processed');

      const p = await repo.claimConsumer(id, 'provider_webhook', 60_000);
      if (!p.claimed) throw new Error('expected provider claim');
      expect(await repo.completeConsumer(id, 'provider_webhook', p.consumer.claimToken)).toBe(true);
      const done = (await repo.findById(id))!;
      expect(done.status).toBe('processed');
      expect(done.processedAt).not.toBeNull();

      // Now — and only now — a further claim is a genuine replay.
      const replay = await repo.claimConsumer(id, 'payment_webhook', 60_000);
      expect(replay.claimed).toBe(false);
      if (!replay.claimed) expect(replay.existing?.status).toBe('processed');
    });

    it('a crashed owner (lease lapsed) can be re-claimed; a live lease cannot', async () => {
      const c = await repo.claim(input('evt_crash'));
      if (!c.claimed) throw new Error('expected claim');
      const owner = await repo.claimConsumer(c.event.id, 'payment_webhook', 60_000);
      expect(owner.claimed).toBe(true);
      const busy = await repo.claimConsumer(c.event.id, 'payment_webhook', 60_000);
      expect(busy.claimed).toBe(false);
      if (!busy.claimed) expect(busy.existing?.status).toBe('processing');

      await main.client`UPDATE webhook_event_consumers SET lease_expires_at = now() - interval '1 second' WHERE webhook_event_id = ${c.event.id}`;
      const rescued = await repo.claimConsumer(c.event.id, 'payment_webhook', 60_000);
      expect(rescued.claimed).toBe(true);
      // The crashed owner waking up late cannot overwrite the rescuer's outcome.
      if (owner.claimed) expect(await repo.failConsumer(c.event.id, 'payment_webhook', owner.consumer.claimToken, 'late')).toBe(false);
    });

    it('20 concurrent claimConsumer calls from independent pools: exactly one owner', async () => {
      const c = await repo.claim(input('evt_consumer_race'));
      if (!c.claimed) throw new Error('expected claim');
      const pools = Array.from({ length: 4 }, () => replicaRepo(5));
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => pools[i % pools.length].claimConsumer(c.event.id, 'payment_webhook', 60_000)),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // At-most-once side effects (events + outbox in one statement)
  // -------------------------------------------------------------------------
  describe('persistEffectsOnce', () => {
    it('writes the events row and the outbox row together, and a retry writes neither again', async () => {
      const args = {
        idempotencyKey: 'webhook:test:payment_webhook',
        event: {
          appId: 'webhook',
          category: 'payment_webhook',
          providerId: 'stripe',
          status: 'success',
          decisionReason: 'payment_webhook_received',
          payload: { a: 1 },
          response: null,
        },
        outbox: { appId: 'webhook', eventType: 'payment_webhook_received', payload: { id: 'evt' } },
      };
      const first = await repo.persistEffectsOnce(args);
      const second = await repo.persistEffectsOnce(args);
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.eventId).toBe(first.eventId);
      const [{ ev }] = await main.client`SELECT count(*)::int AS ev FROM events WHERE idempotency_key = 'webhook:test:payment_webhook'`;
      const [{ ob }] = await main.client`SELECT count(*)::int AS ob FROM outbox_events WHERE event_type = 'payment_webhook_received'`;
      expect(ev).toBe(1);
      expect(ob).toBe(1);
    });

    it('is atomic: if the events insert fails (FK violation), no outbox row is written either', async () => {
      const [{ before }] = await main.client`SELECT count(*)::int AS before FROM outbox_events`;
      const err = await repo
        .persistEffectsOnce({
          idempotencyKey: 'webhook:fk:payment_webhook',
          event: { appId: 'no-such-app', category: 'payment_webhook', providerId: 'stripe', status: 'success', decisionReason: null, payload: {} },
          outbox: { appId: 'no-such-app', eventType: 'payment_webhook_received', payload: {} },
        })
        .then(() => null, (e: unknown) => e);
      expect(pgCode(err)).toBe('23503');
      const [{ after }] = await main.client`SELECT count(*)::int AS after FROM outbox_events`;
      expect(after).toBe(before);
    });
  });
});
