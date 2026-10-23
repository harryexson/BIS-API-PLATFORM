import { describe, it, expect, vi, afterEach } from 'vitest';
import { freePort, redisServerBinaryAvailable, startTestRedis } from '../../workers/src/test-utils/redis-server';
import { EventBus } from './index';

/**
 * Phase 22 — gap register PHASE19-05: the EventBus's Redis SUBSCRIBER
 * connection had no 'error' listener, so an unreachable Redis made ioredis
 * print a raw "[ioredis] Unhandled error event: <stack>" to stderr on every
 * failed reconnect, instead of one clean, structured (redacted) log entry.
 *
 * Real ioredis clients against a real, closed TCP port — no mocks of the
 * client. Needs no redis-server: the point is that nothing is listening.
 */

const PASSWORD = 'EventBusPhase22pw';
const restores: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (restores.length) await restores.pop()!();
});

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

describe('PHASE19-05: EventBus Redis connection errors', () => {
  it('an unreachable Redis yields one structured error entry per connection — no unhandled ioredis error spam, nothing uncaught', async () => {
    const port = await freePort(); // bound then released: connections to it are refused

    const prevUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = `redis://:${PASSWORD}@127.0.0.1:${port}`;
    (EventBus as any).instance = undefined;
    restores.push(() => {
      if (prevUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prevUrl;
      (EventBus as any).instance = undefined;
    });

    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      lines.push(String(chunk));
      return true;
    });
    const consoleErrors: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void consoleErrors.push(a.map(String).join(' ')));
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    restores.push(() => {
      stdout.mockRestore();
      consoleError.mockRestore();
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    });

    const bus = EventBus.getInstance();
    const sub = (bus as any).subClient;
    const pub = (bus as any).redisClient;
    restores.unshift(() => {
      sub.disconnect();
      pub.disconnect();
    });
    // Count reconnect attempts WITHOUT adding an 'error' listener (that would hide the defect).
    let subReconnects = 0;
    sub.on('reconnecting', () => subReconnects++);

    // retryStrategy is times*200ms: wait for several failed attempts on the subscriber.
    await waitFor(() => subReconnects >= 3, 5_000);
    expect(subReconnects).toBeGreaterThanOrEqual(3);

    const entries = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const redisErrors = entries.filter((e) => e.errorCode === 'EVENTBUS_REDIS_ERROR');

    // (a) no unhandled error event, nothing uncaught.
    expect(consoleErrors.filter((m) => m.includes('[ioredis] Unhandled error event'))).toEqual([]);
    expect(uncaught).toEqual([]);

    // (b) a structured entry instead — once per connection per outage, not once per retry.
    const sorted = redisErrors.map((e) => e.connection).sort();
    expect(sorted).toEqual(['publish', 'subscribe']);
    for (const e of redisErrors) {
      expect(e).toMatchObject({
        level: 'error',
        message: 'event bus Redis connection error — retrying in the background',
        operation: 'eventbus-redis',
        status: 'disconnected',
      });
      expect(e.error.code).toBe('ECONNREFUSED');
    }
    expect(lines.join('')).not.toContain(PASSWORD);
    expect(bus.getRedisStatus()).toBe('disconnected');
  }, 15_000);

  // A spawned redis-server on a fixed port, stopped and restarted: each OUTAGE
  // is logged (once per connection), and a recovered connection re-arms it.
  it.skipIf(!redisServerBinaryAvailable || Boolean(process.env.TEST_REDIS_URL))(
    'real redis-server killed, restarted, killed again: one entry per connection per outage, re-armed on reconnect',
    async () => {
      const port = await freePort();
      let redis = await startTestRedis({ port });

      const prevUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = redis.url;
      (EventBus as any).instance = undefined;
      const lines: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        lines.push(String(chunk));
        return true;
      });
      const consoleErrors: string[] = [];
      const consoleError = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void consoleErrors.push(a.map(String).join(' ')));
      const bus = EventBus.getInstance();
      const sub = (bus as any).subClient;
      const pub = (bus as any).redisClient;
      restores.push(async () => {
        sub.disconnect();
        pub.disconnect();
        stdout.mockRestore();
        consoleError.mockRestore();
        await redis.stop();
        if (prevUrl === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = prevUrl;
        (EventBus as any).instance = undefined;
      });

      const redisErrors = () =>
        lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.errorCode === 'EVENTBUS_REDIS_ERROR');
      const bothReady = () => sub.status === 'ready' && pub.status === 'ready';

      await waitFor(bothReady, 10_000);
      expect(bothReady()).toBe(true);
      expect(redisErrors()).toEqual([]);

      await redis.stop();
      await waitFor(() => redisErrors().length >= 2, 10_000);
      // Let several reconnect attempts fail: still one entry per connection.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(redisErrors().map((e) => e.connection).sort()).toEqual(['publish', 'subscribe']);

      redis = await startTestRedis({ port });
      await waitFor(bothReady, 15_000);
      expect(bothReady()).toBe(true);

      await redis.stop();
      await waitFor(() => redisErrors().length >= 4, 10_000);
      expect(redisErrors().map((e) => e.connection).sort()).toEqual(['publish', 'publish', 'subscribe', 'subscribe']);
      expect(consoleErrors.filter((m) => m.includes('[ioredis] Unhandled error event'))).toEqual([]);
    },
    60_000,
  );
});
