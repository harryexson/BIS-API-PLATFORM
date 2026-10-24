import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm';
import { runOutboxPollOnce, type OutboxStore } from './jobs/outboxPoller';
import { createStore } from './client';
import { freePort } from './test-utils/redis-server';

/**
 * Phase 22 — gap register C18, on worker log sites converted from
 * console.* in this phase (no database needed; the real-Postgres version of
 * the outbox proof is packages/database/src/log-redaction.postgres.integration.test.ts):
 *
 *  - the outbox poller's dispatch-failure / failure-record paths, which used
 *    to console.error an interpolated `${errText(err)}` and the raw error
 *    object (a drizzle DrizzleQueryError carries its bound params);
 *  - createStore()'s Redis-unavailable fallback warning (default sink).
 */

const REDIS_PASSWORD = 'R3disWorkerPhase22pw';
const PROVIDER_KEY = 'sk_live_51HxQ9zP22wrkQwErTyUi';
const PHONE = '+265991234567';
const SECRETS = [REDIS_PASSWORD, PROVIDER_KEY, PHONE];

let lines: string[] = [];
let consoleCalls: unknown[][] = [];
const restores: Array<() => void> = [];

beforeEach(() => {
  lines = [];
  consoleCalls = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    lines.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  restores.push(() => out.mockRestore(), () => err.mockRestore(), () => warn.mockRestore());
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

const entries = () => lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

function dispatchError(): Error {
  return new Error(`publish failed via redis://:${REDIS_PASSWORD}@redis:6379 (provider key ${PROVIDER_KEY}, customer ${PHONE})`);
}

function oneRowStore(fail: OutboxStore['fail']): OutboxStore {
  const row = { id: 'obx_1', appId: 'app', eventType: 'payment_webhook_received', payload: {}, attempts: 1, claimToken: 'tok', claimedAt: new Date() };
  return {
    rescueStale: async () => ({ requeued: [], deadLettered: [] }),
    claimBatch: async () => [row as never],
    renewClaim: async () => true,
    complete: async () => true,
    fail,
  };
}

describe('outbox poller logs through the redacting structured logger (C18)', () => {
  it('dispatch failed, will retry: the error text in the entry has its secrets scrubbed', async () => {
    await runOutboxPollOnce(oneRowStore(async () => 'pending'), async () => {
      throw dispatchError();
    });
    const entry = entries().find((e) => e.errorCode === 'OUTBOX_DISPATCH_FAILED');
    expect(entry).toMatchObject({ level: 'warn', operation: 'outbox_poller', status: 'retrying', outboxEventId: 'obx_1', attempts: 1 });
    expect(entry.error.message).toBe(
      'publish failed via redis://:[REDACTED]@redis:6379 (provider key [REDACTED:key], customer [REDACTED:phone])',
    );
    const raw = lines.join('');
    for (const s of SECRETS) expect(raw).not.toContain(s);
    expect(consoleCalls).toEqual([]);
  });

  it('failure-record write throws a DB query error carrying the error text as a bound param: params never reach the log', async () => {
    let thrown: unknown;
    await runOutboxPollOnce(
      oneRowStore(async (_id, _token, errorText) => {
        thrown = new DrizzleQueryError('update "outbox_events" set "last_error" = $1 where "id" = $2', [errorText, 'obx_1'], Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
        throw thrown;
      }),
      async () => {
        throw dispatchError();
      },
    );
    // Control: the thrown error really carries the secrets.
    for (const s of SECRETS) expect(inspect(thrown)).toContain(s);

    const entry = entries().find((e) => e.errorCode === 'OUTBOX_FAIL_UNRECORDED');
    expect(entry).toMatchObject({ level: 'error', operation: 'outbox_poller', status: 'failed', outboxEventId: 'obx_1' });
    expect(entry.error.message).toBe('Failed query: update "outbox_events" set "last_error" = $1 where "id" = $2\nparams: [REDACTED]');
    expect(entry.error.params).toBe('[REDACTED]');
    expect(entry.error.cause).toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' });
    const raw = lines.join('');
    for (const s of SECRETS) expect(raw).not.toContain(s);
    expect(consoleCalls).toEqual([]);
  });
});

describe('createStore fallback warning (default sink) is structured and credential-free', () => {
  it('unreachable Redis URL with a password → one REDIS_UNAVAILABLE entry, password absent', async () => {
    const port = await freePort();
    const store = await createStore(`redis://:${REDIS_PASSWORD}@127.0.0.1:${port}`, { connectTimeoutMs: 300 });
    expect(store.constructor.name).toBe('MemoryStore');
    const entry = entries().find((e) => e.errorCode === 'REDIS_UNAVAILABLE');
    expect(entry).toMatchObject({ level: 'warn', operation: 'create-store', status: 'degraded' });
    expect(entry.redisUrl).toContain(`127.0.0.1:${port}`);
    expect(lines.join('')).not.toContain(REDIS_PASSWORD);
    expect(consoleCalls).toEqual([]);
  });
});
