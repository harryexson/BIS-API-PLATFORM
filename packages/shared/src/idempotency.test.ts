import { describe, it, expect } from 'vitest';
import { PlatformIdempotencyService, computeRequestHash, type IdempotencyStore } from './idempotency';

describe('computeRequestHash', () => {
  it('is a stable SHA-256 hex digest independent of key order', () => {
    const a = computeRequestHash({ amount: 25, currency: 'USD', meta: { b: 1, a: 2 } });
    const b = computeRequestHash({ meta: { a: 2, b: 1 }, currency: 'USD', amount: 25 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('changes when any mutating field changes, and treats undefined members as absent', () => {
    const base = computeRequestHash({ amount: 25, currency: 'USD' });
    expect(computeRequestHash({ amount: 26, currency: 'USD' })).not.toBe(base);
    expect(computeRequestHash({ amount: '25', currency: 'USD' })).not.toBe(base); // no silent coercion
    expect(computeRequestHash({ amount: 25, currency: 'USD', providerOverride: undefined })).toBe(base);
  });
});

describe('PlatformIdempotencyService', () => {
  it('propagates store errors so callers can fail closed (never reports a claim it did not get)', async () => {
    const store: IdempotencyStore = {
      claim: async () => {
        throw new Error('db down');
      },
      complete: async () => true,
      fail: async () => true,
    };
    await expect(new PlatformIdempotencyService(store).checkAndClaim('a', 't', 'payment', 'k', 'h')).rejects.toThrow('db down');
  });

  it('requires a request hash', async () => {
    const store = { claim: async () => ({ claimed: true as const, record: { id: 'x' } }), complete: async () => true, fail: async () => true };
    await expect(new PlatformIdempotencyService(store).checkAndClaim('a', 't', 'payment', 'k', '')).rejects.toThrow('requestHash');
  });

  it('answers in_progress (never claimed) when the row keeps changing under it', async () => {
    let calls = 0;
    const store: IdempotencyStore = {
      claim: async () => {
        calls++;
        return { claimed: false as const, existing: undefined };
      },
      complete: async () => true,
      fail: async () => true,
    };
    const r = await new PlatformIdempotencyService(store).checkAndClaim('a', 't', 'payment', 'k', 'h');
    expect(r.outcome).toBe('in_progress');
    expect(r.claimed).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });
});
