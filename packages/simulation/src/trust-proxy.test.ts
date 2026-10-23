import { describe, it, expect } from 'vitest';
import { parseTrustProxy, MAX_TRUSTED_HOPS } from '../../../services/api-gateway/src/trust-proxy';

/**
 * Phase 23-24 (PHASE14-03 / PHASE20-02): TRUST_PROXY parsing. The end-to-end
 * behaviour (real gateway, real HTTP, forged X-Forwarded-For) is in
 * trust-proxy.simulation.test.ts and trust-proxy-refused.simulation.test.ts.
 */
describe('parseTrustProxy', () => {
  it.each([undefined, '', '  ', 'false', 'FALSE', '0', 'off', 'none'])('%j → trust nothing (the default)', (raw) => {
    const r = parseTrustProxy(raw);
    expect(r.setting).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it.each(['1', '2', String(MAX_TRUSTED_HOPS), ' 1 '])('%j → that many trusted hops', (raw) => {
    const r = parseTrustProxy(raw);
    expect(r.setting).toBe(Number(raw.trim()));
    expect(r.error).toBeUndefined();
  });

  it.each(['true', 'TRUE', '*', 'all', 'yes', 'on'])('blanket trust %j is refused (would let clients pick req.ip)', (raw) => {
    const r = parseTrustProxy(raw);
    expect(r.setting).toBe(false);
    expect(r.error).toMatch(/refused/);
  });

  it.each([String(MAX_TRUSTED_HOPS + 1), '100'])('hop count %j out of range is refused', (raw) => {
    const r = parseTrustProxy(raw);
    expect(r.setting).toBe(false);
    expect(r.error).toMatch(/between 1 and/);
  });

  it('an explicit proxy address list is accepted verbatim', () => {
    const r = parseTrustProxy(' 10.0.0.0/8, fd00::/8 ,192.0.2.10,loopback,uniquelocal ');
    expect(r.setting).toEqual(['10.0.0.0/8', 'fd00::/8', '192.0.2.10', 'loopback', 'uniquelocal']);
    expect(r.error).toBeUndefined();
  });

  it.each([
    '0.0.0.0/0', // every IPv4 address: blanket trust in disguise
    '::/0',
    '10.0.0.0/33',
    '10.0.0.0/abc',
    '10.0.0.300',
    'railway',
    '10.0.0.1,not-an-ip',
    ',,',
    '-1',
  ])('%j is refused as a whole (never partially applied)', (raw) => {
    const r = parseTrustProxy(raw);
    expect(r.setting).toBe(false);
    expect(r.error).toMatch(/refused/);
  });
});
