import { describe, it, expect } from 'vitest';
import { computeProviderScore, rankByScore, weightedRandomSelect, type ScorableCandidate } from './scoring';

function candidate(overrides: Partial<ScorableCandidate> = {}): ScorableCandidate {
  return { id: 'p1', weight: 50, errorRate: 0, ...overrides };
}

describe('computeProviderScore', () => {
  it('scores a healthy, cheap provider higher than an unhealthy, expensive one at equal weight', () => {
    const healthy = candidate({ id: 'healthy', errorRate: 0, transactionFeePercent: 1, transactionFeeFlat: 0 });
    const unhealthy = candidate({ id: 'unhealthy', errorRate: 40, transactionFeePercent: 5, transactionFeeFlat: 0.5 });
    expect(computeProviderScore(healthy, { amount: 100 })).toBeGreaterThan(computeProviderScore(unhealthy, { amount: 100 }));
  });

  it('never drives the score to exactly zero for a struggling-but-not-broken provider', () => {
    const struggling = candidate({ errorRate: 95 });
    expect(computeProviderScore(struggling)).toBeGreaterThan(0);
  });

  it('respects the static weight as a real factor', () => {
    const low = candidate({ id: 'low', weight: 10 });
    const high = candidate({ id: 'high', weight: 90 });
    expect(computeProviderScore(high)).toBeGreaterThan(computeProviderScore(low));
  });

  it('treats an unconfigured cost as neutral rather than infinitely preferred', () => {
    const noCost = candidate({ transactionFeePercent: undefined, transactionFeeFlat: undefined });
    const zeroCost = candidate({ transactionFeePercent: 0, transactionFeeFlat: 0 });
    expect(computeProviderScore(noCost, { amount: 100 })).toBeCloseTo(computeProviderScore(zeroCost, { amount: 100 }), 5);
  });

  it('scores a higher message cost lower for messaging candidates', () => {
    const cheap = candidate({ id: 'cheap', messageCost: 0.001 });
    const expensive = candidate({ id: 'expensive', messageCost: 0.05 });
    expect(computeProviderScore(cheap)).toBeGreaterThan(computeProviderScore(expensive));
  });
});

describe('rankByScore', () => {
  it('orders candidates best-first', () => {
    const a = candidate({ id: 'a', weight: 10 });
    const b = candidate({ id: 'b', weight: 90 });
    const c = candidate({ id: 'c', weight: 50 });
    expect(rankByScore([a, b, c]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const input = [candidate({ id: 'a', weight: 10 }), candidate({ id: 'b', weight: 90 })];
    const copy = [...input];
    rankByScore(input);
    expect(input).toEqual(copy);
  });
});

describe('weightedRandomSelect', () => {
  it('returns the only item when there is exactly one candidate', () => {
    const only = candidate({ id: 'only' });
    expect(weightedRandomSelect([only], (c) => computeProviderScore(c))).toBe(only);
  });

  it('always returns an item from the input list', () => {
    const items = [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' })];
    for (let i = 0; i < 50; i++) {
      const picked = weightedRandomSelect(items, (c) => computeProviderScore(c));
      expect(items).toContain(picked);
    }
  });

  it('picks the overwhelmingly heavier candidate the large majority of the time', () => {
    const heavy = candidate({ id: 'heavy', weight: 1000 });
    const light = candidate({ id: 'light', weight: 1 });
    let heavyWins = 0;
    for (let i = 0; i < 200; i++) {
      if (weightedRandomSelect([heavy, light], (c) => computeProviderScore(c)).id === 'heavy') heavyWins++;
    }
    expect(heavyWins).toBeGreaterThan(180);
  });
});
