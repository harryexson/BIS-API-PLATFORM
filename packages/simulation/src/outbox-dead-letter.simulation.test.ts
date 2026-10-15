import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The gateway reads ADMIN_API_TOKEN once at module load.
const ADMIN_TOKEN = vi.hoisted(() => {
  const token = 'p5-outbox-admin-token';
  process.env.ADMIN_API_TOKEN = token;
  return token;
});

import { dbState, clearDb, seedReachChurch, installDatabaseMock } from './db';

vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

/**
 * Phase 5 — the operator surface for transactional-outbox dead letters, over
 * HTTP through the REAL gateway routes (GET /api/dashboard/outbox,
 * GET /api/dashboard/outbox/dead, POST /api/dashboard/outbox/:id/replay,
 * POST /api/dashboard/outbox/dead/replay).
 *
 * The database is the in-memory double (./db.ts), whose dead-letter methods
 * mirror the real conditional UPDATE ... WHERE status = 'dead'. The real
 * SQL — dead-lettering after maxAttempts, racing replays across separate
 * connection pools, delivery exactly once after replay — is proven on a real
 * Postgres in packages/database/src/outbox.postgres.integration.test.ts.
 * This file proves the routes: admin-gated, correct status codes, and a
 * replay never re-dispatches a row that is not dead.
 */

let runtime: SimRuntime;
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

function seed(status: 'pending' | 'processing' | 'completed' | 'dead', over: Partial<{ appId: string; eventType: string; error: string }> = {}) {
  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    appId: over.appId ?? 'reach-church',
    eventType: over.eventType ?? 'payment_webhook_received',
    payload: { id: `evt_${dbState.outboxEvents.length}` },
    status,
    createdAt: now,
    processedAt: status === 'completed' ? now : null,
    error: over.error ?? (status === 'dead' ? 'Error: receiver down' : null),
    attempts: status === 'dead' ? 10 : 0,
    claimedAt: status === 'processing' ? now : null,
    claimToken: status === 'processing' ? crypto.randomUUID() : null,
    nextAttemptAt: now,
    deadAt: status === 'dead' ? now : null,
    replayCount: 0,
    updatedAt: now,
  };
  dbState.outboxEvents.push(row);
  return row;
}

const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe('Phase 5 — outbox dead-letter admin routes', () => {
  it('every outbox route requires the admin token (403 without / with a wrong one)', async () => {
    const dead = seed('dead');
    const calls = [
      () => runtime.get('/api/dashboard/outbox'),
      () => runtime.get('/api/dashboard/outbox/dead', { 'x-admin-token': 'wrong' }),
      () => runtime.post(`/api/dashboard/outbox/${dead.id}/replay`, {}),
      () => runtime.post('/api/dashboard/outbox/dead/replay', {}, { 'x-admin-token': 'wrong' }),
    ];
    for (const call of calls) expect((await call()).status).toBe(403);
    expect(dbState.outboxEvents.find((r) => r.id === dead.id)!.status).toBe('dead'); // untouched
  });

  it('lists dead letters (with the preserved error) and counts by status', async () => {
    clearOutbox();
    const d1 = seed('dead', { error: 'Error: redis down' });
    const d2 = seed('dead', { appId: 'haulpro', eventType: 'other_event' });
    seed('pending');
    seed('completed');

    const counts = await json(await runtime.get('/api/dashboard/outbox', ADMIN));
    expect(counts.counts).toEqual({ pending: 1, processing: 0, completed: 1, dead: 2 });

    const all = await json(await runtime.get('/api/dashboard/outbox/dead', ADMIN));
    expect(all.data.map((r: any) => r.id).sort()).toEqual([d1.id, d2.id].sort());
    expect(all.data.find((r: any) => r.id === d1.id).error).toBe('Error: redis down');

    const filtered = await json(await runtime.get('/api/dashboard/outbox/dead?appId=haulpro', ADMIN));
    expect(filtered.data.map((r: any) => r.id)).toEqual([d2.id]);
  });

  it('replay: dead → pending once (200); a second replay and any non-dead row → 409 with nothing changed; unknown → 404; malformed id → 400', async () => {
    clearOutbox();
    const dead = seed('dead');
    const completed = seed('completed');
    const inflight = seed('processing');
    const waiting = seed('pending');

    const ok = await runtime.post(`/api/dashboard/outbox/${dead.id}/replay`, {}, ADMIN);
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(body.replayed).toBe(true);
    expect(body.event).toMatchObject({ id: dead.id, status: 'pending', attempts: 0, replayCount: 1 });

    const again = await runtime.post(`/api/dashboard/outbox/${dead.id}/replay`, {}, ADMIN);
    expect(again.status).toBe(409);
    expect((await json(again)).status).toBe('pending');

    for (const r of [completed, inflight, waiting]) {
      const before = { ...dbState.outboxEvents.find((x) => x.id === r.id)! };
      const res = await runtime.post(`/api/dashboard/outbox/${r.id}/replay`, {}, ADMIN);
      expect(res.status).toBe(409);
      expect(dbState.outboxEvents.find((x) => x.id === r.id)).toEqual(before); // a delivered / in-flight row is never re-queued
    }

    expect((await runtime.post(`/api/dashboard/outbox/${crypto.randomUUID()}/replay`, {}, ADMIN)).status).toBe(404);
    expect((await runtime.post('/api/dashboard/outbox/not-a-uuid/replay', {}, ADMIN)).status).toBe(400);
    expect(dbState.outboxEvents.find((r) => r.id === dead.id)!.replayCount).toBe(1);
  });

  it('concurrent replays of one dead letter (double-click / two operators): exactly one 200, the rest 409', async () => {
    clearOutbox();
    const dead = seed('dead');
    const res = await Promise.all(
      Array.from({ length: 5 }, () => runtime.post(`/api/dashboard/outbox/${dead.id}/replay`, {}, ADMIN)),
    );
    expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(dbState.outboxEvents.find((r) => r.id === dead.id)!.replayCount).toBe(1);
  });

  it('batch replay re-queues only dead rows matching the filter, each exactly once', async () => {
    clearOutbox();
    const a = seed('dead', { eventType: 'payment_webhook_received' });
    const b = seed('dead', { eventType: 'payment_webhook_received' });
    const other = seed('dead', { eventType: 'other_event' });
    const done = seed('completed', { eventType: 'payment_webhook_received' });

    // (Regression: this route used to be registered AFTER /outbox/:id/replay,
    // so Express matched :id = 'dead' and answered 400 — batch replay was unreachable.)
    const raw = await runtime.post('/api/dashboard/outbox/dead/replay', { eventType: 'payment_webhook_received' }, ADMIN);
    expect(raw.status).toBe(200);
    const res = await json(raw);
    expect(res.replayed).toBe(2);
    expect(res.ids.sort()).toEqual([a.id, b.id].sort());
    const again = await json(await runtime.post('/api/dashboard/outbox/dead/replay', { eventType: 'payment_webhook_received' }, ADMIN));
    expect(again.replayed).toBe(0);
    const byId = (id: string) => dbState.outboxEvents.find((r) => r.id === id)!;
    expect(byId(a.id)).toMatchObject({ status: 'pending', replayCount: 1 });
    expect(byId(other.id).status).toBe('dead');
    expect(byId(done.id)).toMatchObject({ status: 'completed', replayCount: 0 });
  });
});

function clearOutbox() {
  dbState.outboxEvents = [];
}
