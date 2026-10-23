import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm';

/**
 * Phase 22 — gap register C18 ("console.error calls bypass the structured
 * logger's secret-redaction"), proven on the routing engine's two fail-open
 * DB lookups (the consent check behind A7, and the messaging-profile
 * lookup). Both used to `console.error` an interpolated string — the
 * recipient's phone number and `err.message`, which for a drizzle query
 * error is "Failed query: <sql>\nparams: <raw bound values>".
 *
 * The data access is stubbed (same pattern as channel-policy.test.ts) so the
 * lookups can be made to reject with a REAL drizzle-orm DrizzleQueryError
 * carrying secret-shaped values. A real-Postgres version of the same proof
 * is in packages/database/src/log-redaction.postgres.integration.test.ts.
 *
 * NOT changed here (out of scope, gap register A7 still OPEN): the consent
 * check still FAILS OPEN — asserted below so the behaviour is visible.
 */

const RECIPIENT = '+265991234567';
const STRIPE_KEY = 'sk_live_51HxQ9zP22rtgQwErTyUi';
const DB_PASSWORD = 'routing-Phase22-pw';
const CONTENT = 'Your one-time code is 913377';

const db = vi.hoisted(() => ({ consentThrows: false, profilesThrow: false, makeError: (() => new Error('unset')) as () => Error }));

vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consentRecordRepository: {
      isOptedOut: async () => {
        if (db.consentThrows) throw db.makeError();
        return false;
      },
      findByRecipient: async () => undefined,
    },
    messagingProfileRepository: {
      findSendersForOwner: async () => {
        if (db.profilesThrow) throw db.makeError();
        return [];
      },
    },
    senderOptOutRepository: { isOptedOut: async () => false },
    conversationRepository: {
      findActiveForOwner: async () => [],
      upsert: async () => ({ id: 'c1' }),
    },
  };
});

import { RoutingEngine } from './index';

/** The exact error drizzle throws for a failed statement, wrapping a driver error. */
function realDrizzleError(): DrizzleQueryError {
  const driverError = Object.assign(new Error(`could not connect to server (postgres://bis_app:${DB_PASSWORD}@db.internal:5432/bis)`), {
    code: '28P01',
  });
  return new DrizzleQueryError(
    'select "status" from "consent_records" where ("app_id" = $1 and "recipient" = $2 and "note" = $3)',
    ['reach', RECIPIENT, `${STRIPE_KEY} ${CONTENT}`],
    driverError,
  );
}

let lines: string[] = [];
let consoleCalls: unknown[][] = [];
const restores: Array<() => void> = [];

beforeEach(() => {
  db.consentThrows = false;
  db.profilesThrow = false;
  db.makeError = realDrizzleError;
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

describe('routing fail-open lookups log through the redacting structured logger (C18)', () => {
  it('control: the error really carries every secret (so the assertions below are not vacuous)', () => {
    const shown = inspect(realDrizzleError());
    for (const secret of [RECIPIENT, STRIPE_KEY, DB_PASSWORD, CONTENT]) expect(shown).toContain(secret);
    expect(realDrizzleError().message).toContain(RECIPIENT); // String(err) / err.message carry the params too
  });

  it('consent lookup failure: one structured error entry, no recipient / params / password anywhere in the output', async () => {
    db.consentThrows = true;
    const event = await new RoutingEngine().routeMessage('reach', { recipient: RECIPIENT, content: CONTENT, channel: 'sms', tenantId: 't1' });

    // A7 is unchanged and still OPEN: the send proceeds on a consent-store error.
    expect(event.category).toBe('messaging');

    const entry = entries().find((e) => e.errorCode === 'CONSENT_LOOKUP_FAILED');
    expect(entry).toBeDefined();
    // First and foremost: no secret anywhere in what was written.
    const raw = lines.join('');
    for (const secret of [RECIPIENT, STRIPE_KEY, DB_PASSWORD, CONTENT]) expect(raw).not.toContain(secret);
    expect(entry).toMatchObject({
      level: 'error',
      message: 'consent lookup failed — failing open (send proceeds)',
      operation: 'routing-consent-check',
      applicationId: 'reach',
      tenantId: 't1',
      channel: 'sms',
      status: 'failed_open',
    });
    // The diagnosis survives: SQL text and the driver's SQLSTATE.
    expect(entry.error.message).toContain('Failed query: select "status" from "consent_records"');
    expect(entry.error.message).toContain('params: [REDACTED]');
    expect(entry.error.params).toBe('[REDACTED]');
    expect(entry.error.cause.code).toBe('28P01');
    expect(entry.error.cause.message).toBe('could not connect to server (postgres://bis_app:[REDACTED]@db.internal:5432/bis)');
    // Nothing went around the logger.
    expect(consoleCalls).toEqual([]);
  });

  it('messaging-profile lookup failure: same guarantees', async () => {
    db.profilesThrow = true;
    await new RoutingEngine().routeMessage('reach', { recipient: RECIPIENT, content: CONTENT, channel: 'sms', tenantId: 't1' });

    const entry = entries().find((e) => e.errorCode === 'MESSAGING_PROFILE_LOOKUP_FAILED');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ level: 'error', operation: 'routing-sender-resolution', applicationId: 'reach', tenantId: 't1', status: 'failed_open' });
    expect(typeof entry.providerId).toBe('string');
    expect(entry.error.cause.code).toBe('28P01');

    const raw = lines.join('');
    for (const secret of [RECIPIENT, STRIPE_KEY, DB_PASSWORD, CONTENT]) expect(raw).not.toContain(secret);
    expect(consoleCalls).toEqual([]);
  });
});
