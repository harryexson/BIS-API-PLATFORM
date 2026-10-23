import { describe, it, expect, beforeEach, vi } from 'vitest';
import { redact } from './redact';
import { metrics, Metrics } from './metrics';
import { logger } from './logger';

describe('redact', () => {
  it('redacts sensitive keys (passwords, api keys, secrets, tokens)', () => {
    const input = {
      username: 'alice',
      password: 'hunter2',
      apiKey: 'sk_live_abc123',
      client_secret: 'shh',
      authorization: 'Bearer xyz',
      nested: { cardNumber: '4111111111111111', cvv: '123', cardData: '4111 1111 1111 1111' },
    };
    const out = redact(input);
    expect(out.username).toBe('alice');
    expect(out.password).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.client_secret).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.nested.cardNumber).toBe('[REDACTED]');
    expect(out.nested.cvv).toBe('[REDACTED]');
    expect(out.nested.cardData).toBe('[REDACTED:card]');
  });

  it('redacts PII values (emails) and trims oversized strings', () => {
    const out = redact({ email: 'a@b.com', note: 'x'.repeat(2500) });
    expect(out.email).toBe('[REDACTED:email]');
    expect(out.note.endsWith('[truncated]')).toBe(true);
  });

  it('leaves non-sensitive data intact', () => {
    const out = redact({ amount: 100, currency: 'USD', status: 'success' });
    expect(out).toEqual({ amount: 100, currency: 'USD', status: 'success' });
  });
});

describe('Metrics', () => {
  let m: Metrics;
  beforeEach(() => {
    m = new Metrics();
  });

  it('increments counters', () => {
    m.increment('paymentSuccess');
    m.increment('paymentSuccess');
    m.increment('apiErrors');
    expect(m.snapshot().counters.paymentSuccess).toBe(2);
    expect(m.snapshot().counters.apiErrors).toBe(1);
  });

  it('records latency and computes percentiles', () => {
    for (let i = 1; i <= 100; i++) m.recordLatency(i);
    const lat = m.snapshot().latency;
    expect(lat.count).toBe(100);
    expect(lat.avg).toBe(50.5);
    expect(lat.p50).toBe(50);
    expect(lat.p95).toBe(95);
    expect(lat.p99).toBe(99);
  });

  it('tracks provider health with numeric values', () => {
    m.setProviderHealth('stripe', 'healthy');
    m.setProviderHealth('nmi', 'down');
    expect(m.providerHealthValue('healthy')).toBe(2);
    expect(m.providerHealthValue('down')).toBe(0);
    expect(m.snapshot().providerHealth.stripe).toBe('healthy');
  });

  it('emits a Prometheus representation', () => {
    m.increment('paymentFailure');
    m.setProviderHealth('stripe', 'degraded');
    const text = m.toPrometheus();
    expect(text).toContain('bis_paymentFailure 1');
    expect(text).toContain('bis_provider_health{provider="stripe"} 1');
  });
});

describe('Logger', () => {
  beforeEach(() => {
    logger.clearLogs();
  });

  it('emits structured JSON with context and redacted fields, and retains a buffer', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.info('hello', { applicationId: 'reachchurch', password: 'secret', latency: 12 });
    spy.mockRestore();

    const logs = logger.getRecentLogs();
    expect(logs.length).toBe(1);
    const entry = logs[0];
    expect(entry.message).toBe('hello');
    expect(entry.level).toBe('info');
    expect(entry.applicationId).toBe('reachchurch');
    expect(entry.latency).toBe(12);
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.timestamp).toBeDefined();
  });

  it('omits undefined context fields', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.warn('no-ctx');
    spy.mockRestore();
    const entry = logger.getRecentLogs()[0];
    expect(entry.tenantId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 22 (gap register C18): errors and secret-shaped VALUES. Before this
// phase an Error passed as a field serialized to its ENUMERABLE props only
// (for a drizzle query error: the raw bound `params`), and value-shaped
// secrets (connection-string passwords, provider keys, phone numbers) in a
// string passed through untouched.
// ---------------------------------------------------------------------------

const PHONE = '+265991234567';
const STRIPE_KEY = 'sk_live_51HxQ9zP22obsQwErTyUi';
const DB_PASSWORD = 'pg-Phase22-pw';
const CONN = `postgres://bis_app:${DB_PASSWORD}@db.internal:5432/bis`;

/** Same shape as drizzle-orm's DrizzleQueryError (constructed for real in the routing/worker tests). */
function drizzleShapedError(): Error {
  const cause = Object.assign(new Error(`could not connect using ${CONN}`), {
    code: '08006',
    detail: `Key (recipient)=(${PHONE}) already exists.`,
  });
  const err = new Error(`Failed query: select "status" from "consent_records" where "recipient" = $1 and "key" = $2\nparams: ${PHONE},${STRIPE_KEY}`);
  Object.assign(err, { query: 'select "status" from "consent_records" where "recipient" = $1 and "key" = $2', params: [PHONE, STRIPE_KEY] });
  (err as any).cause = cause;
  return err;
}

describe('redact — errors and secret-shaped values (Phase 22)', () => {
  it('serializes an Error (name, message, stack frames, code, cause) instead of dropping it to {}', () => {
    const out = redact({ error: Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }) });
    expect(out.error.name).toBe('Error');
    expect(out.error.message).toBe('relation "x" does not exist');
    expect(out.error.code).toBe('42P01');
    expect(typeof out.error.stack).toBe('string');
    expect(out.error.stack).not.toContain('relation "x"'); // frames only — the message is not repeated
  });

  it('a DB query error keeps its SQL but never its bound params, connection-string password or row detail', () => {
    const out = redact({ error: drizzleShapedError() });
    const text = JSON.stringify(out);
    expect(out.error.message).toContain('Failed query: select "status" from "consent_records"');
    expect(out.error.message).toContain('params: [REDACTED]');
    expect(out.error.params).toBe('[REDACTED]');
    expect(out.error.cause.code).toBe('08006');
    expect(out.error.cause.detail).toBe('[REDACTED]');
    expect(out.error.cause.message).toBe('could not connect using postgres://bis_app:[REDACTED]@db.internal:5432/bis');
    for (const secret of [PHONE, STRIPE_KEY, DB_PASSWORD]) expect(text).not.toContain(secret);
  });

  it('scrubs secret-shaped substrings in place, leaving the rest of the text readable', () => {
    expect(redact(`connect failed: redis://:R3disPw@cache:6379`)).toBe('connect failed: redis://:[REDACTED]@cache:6379');
    expect(redact(`provider said: invalid ${STRIPE_KEY}`)).toBe('provider said: invalid [REDACTED:key]');
    expect(redact('endpoint secret whsec_0123456789abcdef0123')).toBe('[REDACTED]'); // "secret" keyword: whole value, as before
    expect(redact('signing with whsec_0123456789abcdef0123')).toBe('signing with [REDACTED:key]');
    expect(redact(`raw key ${'ab12'.repeat(16)}`)).toBe('raw key [REDACTED:hex]');
    expect(redact(`delivery to ${PHONE} failed`)).toBe('delivery to [REDACTED:phone] failed');
    expect(redact('upstream replied 401 to Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('upstream replied 401 to Bearer [REDACTED]');
  });

  it('String(err) / err.message of a DB query error (the gateway house style) loses its params too', () => {
    expect(redact(String(drizzleShapedError()))).toContain('params: [REDACTED]');
    expect(redact(drizzleShapedError().message)).not.toContain(PHONE);
  });
});

describe('Logger — Phase 22', () => {
  beforeEach(() => logger.clearLogs());

  it('the emitted line never carries the secret, and the structured fields survive', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      lines.push(String(chunk));
      return true;
    });
    logger.error('consent lookup failed', { operation: 'routing-consent-check', errorCode: 'CONSENT_LOOKUP_FAILED', status: 'failed_open', error: drizzleShapedError() });
    // A message that interpolates a value is scrubbed as well (it is never key-word redacted: it stays readable).
    logger.warn(`Redis unavailable at ${CONN} for ${PHONE}`, { operation: 'x' });
    spy.mockRestore();

    const raw = lines.join('');
    for (const secret of [PHONE, STRIPE_KEY, DB_PASSWORD]) expect(raw).not.toContain(secret);
    const [first, second] = lines.map((l) => JSON.parse(l));
    expect(first).toMatchObject({ level: 'error', operation: 'routing-consent-check', errorCode: 'CONSENT_LOOKUP_FAILED', status: 'failed_open' });
    expect(first.error.cause.code).toBe('08006');
    expect(second.message).toBe('Redis unavailable at postgres://bis_app:[REDACTED]@db.internal:5432/bis for [REDACTED:phone]');
  });
});
