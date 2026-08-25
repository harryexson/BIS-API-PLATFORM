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
