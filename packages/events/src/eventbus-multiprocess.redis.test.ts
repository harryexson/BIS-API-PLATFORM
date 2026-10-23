import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import Redis from 'ioredis';
import { redisAvailable, startTestRedis, type TestRedis } from '../../workers/src/test-utils/redis-server';

/**
 * Gap register PHASE7-01 — CHARACTERIZATION of an OPEN defect, investigated
 * in Phase 19 with genuinely separate OS processes and a real Redis:
 *
 * The EventBus PUBLISHES every event to the Redis channel `bis:events`, but
 * no code path ever SUBSCRIBES to that channel (EventBus.subscribeChannel is
 * private and has no caller; subscribe() only registers an in-process
 * listener). So an event emitted in the worker process never reaches the
 * gateway process, where outbound merchant webhooks are dispatched
 * (services/api-gateway/src/app.ts eventBus.subscribe → dispatchOutboundWebhooks).
 *
 * These assertions describe CURRENT behaviour. When PHASE7-01 is fixed the
 * last assertion of the first test must flip to `toContain(eventId)` — that
 * failure is the intended signal, not a regression.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = 'packages/events/src/test-fixtures/eventbus-peer.ts';

function runPeer(args: string[], redisUrl: string, onLine?: (line: any) => void): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [FIXTURE, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, REDIS_URL: redisUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: any[] = [];
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw.startsWith('{')) continue;
        const parsed = JSON.parse(raw);
        lines.push(parsed);
        onLine?.(parsed);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? resolve(lines) : reject(new Error(`peer ${args[0]} exited ${code}: ${err.slice(-1500)}`))));
  });
}

describe.skipIf(!redisAvailable)('PHASE7-01: EventBus cross-process delivery (separate OS processes, real Redis)', () => {
  let redis: TestRedis;
  beforeAll(async () => {
    redis = await startTestRedis();
  });
  afterAll(async () => {
    await redis?.stop();
  });

  it('an event the worker publishes reaches Redis, but NOT the gateway process\'s EventBus listener (open defect)', async () => {
    const eventId = `evt_p7_${randomBytes(4).toString('hex')}`;
    const admin = new Redis(redis.url);
    const control = new Redis(redis.url);
    try {
      let markGatewayReady!: (pid: number) => void;
      const gatewayReady = new Promise<number>((r) => (markGatewayReady = r));
      const gateway = runPeer(['listen', '3000'], redis.url, (line) => line.ready && markGatewayReady(line.pid));
      const gatewayPid = await gatewayReady;

      // With the gateway-role EventBus connected and listening, Redis knows
      // of NO subscriber on the channel the worker publishes to.
      expect(await admin.pubsub('NUMSUB', 'bis:events')).toEqual(['bis:events', 0]);

      // Control: a raw subscriber proves the publish really happens.
      const seenByControl: string[] = [];
      await control.subscribe('bis:events');
      control.on('message', (_ch, msg) => seenByControl.push(JSON.parse(msg).id));

      // Phase 22: the peer's stdout also carries the EventBus's structured
      // JSON log lines (e.g. "event bus Redis connected"), so pick the
      // result line by its shape rather than by position.
      const emitted = (await runPeer(['emit', eventId], redis.url)).find((l) => 'emitted' in l);
      expect(emitted.emitted).toBe(eventId);
      expect(emitted.pid).not.toBe(gatewayPid);
      expect(emitted.pid).not.toBe(process.pid);

      const lines = await gateway;
      const result = lines.find((l) => Array.isArray(l.received));
      expect(seenByControl).toContain(eventId);
      // PHASE7-01: the gateway process never sees it.
      expect(result.received).not.toContain(eventId);
    } finally {
      admin.disconnect();
      control.disconnect();
    }
  }, 60_000);

  it('within ONE process the same listener does receive it (why single-process tests never exposed this)', async () => {
    const eventId = `evt_p7_local_${randomBytes(4).toString('hex')}`;
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = redis.url;
    try {
      const { EventBus } = await import('./index');
      const bus = EventBus.getInstance();
      const deadline = Date.now() + 10_000;
      while (bus.getRedisStatus() !== 'connected' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const received: string[] = [];
      const unsub = bus.subscribe((e) => received.push(e.id));
      await bus.emitOrThrow({ id: eventId, timestamp: new Date().toISOString(), appId: 'a', category: 'payment', providerId: 'stripe', status: 'success', latency: 1, cost: 0 } as never);
      unsub();
      expect(received).toEqual([eventId]);
    } finally {
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
    }
  }, 30_000);
});
