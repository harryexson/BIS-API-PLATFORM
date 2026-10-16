import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import Redis from 'ioredis';

/**
 * Test helper: a REAL, throwaway redis-server on a free port (not a mock).
 * Used by the B1 regression test and the Phase-4 webhook pipeline test.
 *
 * Availability: TEST_REDIS_URL (an existing server the tests may write to)
 * wins; otherwise a `redis-server` binary on PATH is spawned. If neither is
 * available the calling suite should skip (see `redisAvailable`).
 * TEST_SKIP_REDIS=1 forces the no-Redis path (e.g. to exercise the
 * memory-only branch of the Phase-4 pipeline test on a machine that has
 * redis-server installed).
 */

export const redisServerBinaryAvailable = (() => {
  try {
    return spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

export const redisAvailable =
  !process.env.TEST_SKIP_REDIS && (Boolean(process.env.TEST_REDIS_URL) || redisServerBinaryAvailable);

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface TestRedis {
  url: string;
  /** Stop the server (no-op for an external TEST_REDIS_URL). */
  stop(): Promise<void>;
}

async function waitForPing(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    c.on('error', () => undefined);
    try {
      await c.connect();
      if ((await c.ping()) === 'PONG') {
        c.disconnect();
        return;
      }
    } catch {
      // not up yet
    }
    c.disconnect();
    if (Date.now() > deadline) throw new Error(`redis at ${url} did not answer PING within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * `opts.port` (spawned server only) lets a test kill the server and start a
 * new one on the SAME port, i.e. a Redis restart that existing clients
 * reconnect to. Ignored when TEST_REDIS_URL is set.
 */
export async function startTestRedis(opts: { port?: number } = {}): Promise<TestRedis> {
  if (process.env.TEST_REDIS_URL) {
    await waitForPing(process.env.TEST_REDIS_URL, 5_000);
    return { url: process.env.TEST_REDIS_URL, stop: async () => undefined };
  }
  const port = opts.port ?? (await freePort());
  const child: ChildProcess = spawn(
    'redis-server',
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    { stdio: 'ignore' },
  );
  const url = `redis://127.0.0.1:${port}`;
  try {
    await waitForPing(url, 10_000);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
