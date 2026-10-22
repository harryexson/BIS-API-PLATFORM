import { describe, it, expect } from 'vitest';
import {
  parseMoneyAmount,
  parseCurrencyCode,
  parseMessageRecipient,
  parseMessageContent,
  parseProviderConfigUpdate,
  parseProviderManagementUpdate,
  MAX_MONEY_AMOUNT,
  MAX_MESSAGE_CONTENT_LENGTH,
} from './index';

// Phase 17-18 (gap register C10 / F11): pure request-field validation. The
// same parsers are exercised through the real gateway routes in
// packages/simulation/src/api-contract-validation.simulation.test.ts and
// provider-state.scenarios.ts.

describe('parseMoneyAmount — MAJOR currency units, at most 2 decimals', () => {
  it.each([
    [49.99, 49.99],
    ['49.99', 49.99],
    [25, 25],
    ['25', 25],
    [0.01, 0.01],
    [100.1, 100.1],
    [MAX_MONEY_AMOUNT, MAX_MONEY_AMOUNT],
  ])('accepts %j as %d', (raw, expected) => {
    expect(parseMoneyAmount(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    [undefined],
    [null],
    [''],
    [true], // Number(true) === 1 — used to charge 1.00
    [false],
    [[5]], // Number([5]) === 5
    [{}],
    ['abc'],
    ['0x10'], // Number('0x10') === 16
    ['1e3'], // Number('1e3') === 1000
    [' 5'],
    ['5 '],
    ['+5'],
    ['.5'],
    ['5.'],
    [0],
    ['0'],
    ['0.00'],
    [-5],
    ['-5'],
    [49.999999],
    ['49.999'],
    [0.1 + 0.2], // 0.30000000000000004
    [0.001],
    [1e-7],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [MAX_MONEY_AMOUNT + 1],
    [1e21],
  ])('rejects %j', (raw) => {
    const r = parseMoneyAmount(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('amount');
  });

  it('names the field it was given and explains the unit', () => {
    const r = parseMoneyAmount('x', 'refundAmount');
    expect(r).toMatchObject({ ok: false, field: 'refundAmount' });
    if (!r.ok) expect(r.message).toMatch(/major currency units/);
  });
});

describe('parseCurrencyCode', () => {
  it('accepts a 3-letter code unchanged and treats absent as undefined when optional', () => {
    expect(parseCurrencyCode('USD', { required: true })).toEqual({ ok: true, value: 'USD' });
    expect(parseCurrencyCode('mwk', { required: true })).toEqual({ ok: true, value: 'mwk' });
    expect(parseCurrencyCode(undefined, { required: false })).toEqual({ ok: true, value: undefined });
    expect(parseCurrencyCode('', { required: false })).toEqual({ ok: true, value: undefined });
  });

  it.each([[5], ['US'], ['DOLLARS'], ['U$D'], [['USD']], [true]])('rejects %j', (raw) => {
    expect(parseCurrencyCode(raw, { required: false })).toMatchObject({ ok: false, field: 'currency' });
  });

  it('rejects an absent currency when required', () => {
    expect(parseCurrencyCode(undefined, { required: true })).toMatchObject({ ok: false, field: 'currency' });
  });
});

describe('parseMessageRecipient / parseMessageContent', () => {
  it.each([
    ['+265888000111'],
    ['265888000111'],
    ['+1 (555) 777-0006'],
    ['whatsapp:+15550001111'],
    ['tel:+15550001111'],
    ['12345'], // short code
    ['donor@reach.example'],
  ])('accepts recipient %j unchanged', (raw) => {
    expect(parseMessageRecipient(raw)).toEqual({ ok: true, value: raw });
  });

  it.each([
    [undefined],
    [''],
    ['   '],
    [12345],
    [['+15550001111']],
    ['not a phone'],
    ['call me maybe'],
    ['12'],
    ['+1234567890123456'], // 16 digits > E.164 max
    ['a@b'],
    ['user@'],
    ['two words@example.com'],
    [`${'a'.repeat(250)}@example.com`],
  ])('rejects recipient %j', (raw) => {
    expect(parseMessageRecipient(raw)).toMatchObject({ ok: false, field: 'recipient' });
  });

  it('accepts a non-blank body up to the limit and rejects empty, blank, non-string and oversized ones', () => {
    expect(parseMessageContent('Your appointment is confirmed.')).toEqual({ ok: true, value: 'Your appointment is confirmed.' });
    expect(parseMessageContent('x'.repeat(MAX_MESSAGE_CONTENT_LENGTH)).ok).toBe(true);
    for (const raw of [undefined, null, '', '   \n\t', 42, { text: 'hi' }, 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)]) {
      expect(parseMessageContent(raw), JSON.stringify(raw)?.slice(0, 40)).toMatchObject({ ok: false, field: 'content' });
    }
  });
});

describe('parseProviderConfigUpdate / parseProviderManagementUpdate (PHASE15-02/03)', () => {
  it('passes through exactly the persisted config fields', () => {
    expect(parseProviderConfigUpdate({ status: 'offline', weight: 40, latencyMin: 5, latencyMax: 9 })).toEqual({
      ok: true,
      value: { status: 'offline', weight: 40, latencyMin: 5, latencyMax: 9 },
    });
  });

  it.each([
    [{ name: 'Renamed' }, 'name'],
    [{ category: 'messaging' }, 'category'],
    [{ id: 'other' }, 'id'],
    [{ status: 'online', name: 'Renamed' }, 'name'],
    [{ currencies: ['USD'] }, 'currencies'], // management-only field on the config route
    [{ status: 'broken' }, 'status'],
    [{ weight: '50' }, 'weight'],
    [{ weight: 101 }, 'weight'],
    [{ weight: Number.NaN }, 'weight'],
    [{ latencyMin: -1 }, 'latencyMin'],
    [{ latencyMin: 10, latencyMax: 5 }, 'latencyMin'],
    [{ transactionFeePercent: 150 }, 'transactionFeePercent'],
    [{}, 'body'],
    [['status'], 'body'],
    ['status=offline', 'body'],
    [null, 'body'],
  ])('config route rejects %j (field %s)', (body, field) => {
    expect(parseProviderConfigUpdate(body)).toMatchObject({ ok: false, field });
  });

  it('management route: normalises country/currency codes the way routing compares them', () => {
    expect(
      parseProviderManagementUpdate({ currencies: ['usd', 'Gbp', '*'], countries: ['us', 'GB'], capabilities: ['card'], priority: 70, environment: 'live' }),
    ).toEqual({
      ok: true,
      value: { currencies: ['USD', 'GBP', '*'], countries: ['US', 'GB'], capabilities: ['card'], priority: 70, environment: 'live' },
    });
  });

  it.each([
    [{ currencies: 'USD' }, 'currencies'], // PHASE15-03: used to persist as ["U","S","D"]
    [{ countries: 'US' }, 'countries'],
    [{ capabilities: 'card' }, 'capabilities'],
    [{ currencies: ['USDT'] }, 'currencies'],
    [{ currencies: [5] }, 'currencies'],
    [{ countries: ['USA'] }, 'countries'],
    [{ capabilities: [''] }, 'capabilities'],
    [{ environment: 'prod' }, 'environment'],
    [{ priority: '70' }, 'priority'],
    [{ health: 'healthy' }, 'health'], // runtime telemetry, not configuration
    [{ errorRate: 0 }, 'errorRate'],
    [{ lastSuccessfulRequest: null }, 'lastSuccessfulRequest'],
    [{ circuitState: 'closed' }, 'circuitState'],
    [{ routingRules: 'currency == USD' }, 'routingRules'],
    [{ routingRules: [{ id: 'r1', match: 'currency == USD' }] }, 'routingRules[0].target'],
    [{ routingRules: [{ id: 'r1', match: 'x', target: 'stripe', enabled: 'yes' }] }, 'routingRules[0].enabled'],
    [{ routingRules: [{ id: 'r1', match: 'x', target: 'stripe', extra: 1 }] }, 'routingRules[0].extra'],
  ])('management route rejects %j (field %s)', (body, field) => {
    expect(parseProviderManagementUpdate(body)).toMatchObject({ ok: false, field });
  });

  it('management route: routing rules are stored with an explicit `enabled`, as every replica loads them', () => {
    expect(parseProviderManagementUpdate({ routingRules: [{ id: 'r1', match: 'currency == USD', target: 'stripe' }] })).toEqual({
      ok: true,
      value: { routingRules: [{ id: 'r1', match: 'currency == USD', target: 'stripe', enabled: true }] },
    });
  });
});
