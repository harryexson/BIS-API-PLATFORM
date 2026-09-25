import { describe, it, expect } from 'vitest';
import { RoutingRule } from '@company/schemas';
import { evaluateRule, findMatchingRule } from './rules';

function makeRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'rule_1',
    match: 'currency == USD',
    target: 'stripe',
    enabled: true,
    ...overrides,
  };
}

describe('evaluateRule', () => {
  it('matches a simple equality clause', () => {
    expect(evaluateRule(makeRule({ match: 'currency == USD' }), { currency: 'USD' })).toBe(true);
    expect(evaluateRule(makeRule({ match: 'currency == USD' }), { currency: 'MWK' })).toBe(false);
  });

  it('is case-insensitive for string fields', () => {
    expect(evaluateRule(makeRule({ match: 'currency == usd' }), { currency: 'USD' })).toBe(true);
  });

  it('supports numeric comparators on amount', () => {
    expect(evaluateRule(makeRule({ match: 'amount > 100' }), { amount: 150 })).toBe(true);
    expect(evaluateRule(makeRule({ match: 'amount > 100' }), { amount: 50 })).toBe(false);
    expect(evaluateRule(makeRule({ match: 'amount >= 100' }), { amount: 100 })).toBe(true);
    expect(evaluateRule(makeRule({ match: 'amount <= 100' }), { amount: 100 })).toBe(true);
    expect(evaluateRule(makeRule({ match: 'amount < 100' }), { amount: 99 })).toBe(true);
    expect(evaluateRule(makeRule({ match: 'amount != 100' }), { amount: 99 })).toBe(true);
  });

  it('supports AND-joined multi-clause rules', () => {
    const rule = makeRule({ match: 'currency == MWK AND amount > 50' });
    expect(evaluateRule(rule, { currency: 'MWK', amount: 100 })).toBe(true);
    expect(evaluateRule(rule, { currency: 'MWK', amount: 10 })).toBe(false);
    expect(evaluateRule(rule, { currency: 'USD', amount: 100 })).toBe(false);
  });

  it('matches paymentMethod and channel fields', () => {
    expect(evaluateRule(makeRule({ match: 'paymentMethod == mobile_money' }), { paymentMethod: 'mobile_money' })).toBe(true);
    expect(evaluateRule(makeRule({ match: 'channel == whatsapp' }), { channel: 'whatsapp' })).toBe(true);
  });

  it('never matches when the referenced field is absent from context (fails closed)', () => {
    expect(evaluateRule(makeRule({ match: 'currency == USD' }), {})).toBe(false);
    expect(evaluateRule(makeRule({ match: 'channel == sms' }), { currency: 'USD' })).toBe(false);
  });

  it('never matches an unparseable match expression rather than throwing', () => {
    expect(() => evaluateRule(makeRule({ match: 'this is not valid' }), { currency: 'USD' })).not.toThrow();
    expect(evaluateRule(makeRule({ match: 'this is not valid' }), { currency: 'USD' })).toBe(false);
  });

  it('never matches an unknown field name', () => {
    expect(evaluateRule(makeRule({ match: 'bin == 411111' }), { currency: 'USD' })).toBe(false);
  });

  it('never applies a numeric comparator to a string field', () => {
    expect(evaluateRule(makeRule({ match: 'currency > USD' }), { currency: 'USD' })).toBe(false);
  });
});

describe('findMatchingRule', () => {
  it('returns the first enabled rule whose match holds', () => {
    const rules = [
      makeRule({ id: 'r1', match: 'currency == MWK', target: 'paychangu' }),
      makeRule({ id: 'r2', match: 'currency == USD', target: 'stripe' }),
    ];
    expect(findMatchingRule(rules, { currency: 'USD' })?.id).toBe('r2');
  });

  it('skips a disabled rule even if it would otherwise match', () => {
    const rules = [makeRule({ id: 'r1', match: 'currency == USD', enabled: false })];
    expect(findMatchingRule(rules, { currency: 'USD' })).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    const rules = [makeRule({ match: 'currency == MWK' })];
    expect(findMatchingRule(rules, { currency: 'USD' })).toBeUndefined();
  });
});
