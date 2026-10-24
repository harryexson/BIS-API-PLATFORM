import { describe, it, expect } from 'vitest';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  AdminCredentialSet,
  hashAdminToken,
  loadAdminCredentials,
  parseAdminCredentials,
  LEGACY_ADMIN_ID,
  MAX_ADMIN_TOKEN_LENGTH,
} from '../../../services/api-gateway/src/admin-auth';

/**
 * Phase 20-21 (gap register C7 / PHASE14-06) — the admin credential set
 * itself (services/api-gateway/src/admin-auth.ts). The HTTP behaviour is in
 * admin-auth.scenarios.ts; this file pins down the parts HTTP cannot show:
 * the comparison is a fixed-length constant-time compare against EVERY
 * credential (no early exit), and configuration fails closed.
 */

const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('C7 — admin token comparison is constant-time', () => {
  const tokens = ['tok-alice-' + 'a'.repeat(40), 'tok-bob-' + 'b'.repeat(40), 'tok-carol-' + 'c'.repeat(40)];
  const creds = parseAdminCredentials(`alice:${hex(tokens[0])},bob:${hex(tokens[1])},carol:${hex(tokens[2])}`).credentials;

  function observedSet() {
    const calls: Array<{ a: number; b: number }> = [];
    const set = new AdminCredentialSet(creds, (a, b) => {
      calls.push({ a: a.length, b: b.length });
      return timingSafeEqual(a, b);
    });
    return { set, calls };
  }

  it.each([
    ['the first credential', tokens[0], 'alice'],
    ['the last credential', tokens[2], 'carol'],
    ['no credential (wrong token)', 'wrong', null],
    ['no credential (a 1-char token)', 'x', null],
    ['no credential (a prefix of a real token)', tokens[1].slice(0, 10), null],
    ['no credential (the longest accepted token)', 'z'.repeat(MAX_ADMIN_TOKEN_LENGTH), null],
  ])('matching %s does exactly one 32-byte comparison per credential — no early exit, no length leak', (_label, token, expected) => {
    const { set, calls } = observedSet();
    const result = set.verify(token, false);
    expect(result?.id ?? null).toBe(expected);
    expect(calls).toEqual([{ a: 32, b: 32 }, { a: 32, b: 32 }, { a: 32, b: 32 }]);
  });

  it('an over-long or empty token is refused without hashing it', () => {
    const { set, calls } = observedSet();
    expect(set.verify('z'.repeat(MAX_ADMIN_TOKEN_LENGTH + 1), false)).toBeNull();
    expect(set.verify('', false)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('the configured hash itself is not a credential', () => {
    expect(new AdminCredentialSet(creds).verify(hex(tokens[0]), false)).toBeNull();
  });
});

describe('C7 — named admin credentials configuration fails closed', () => {
  it('parses "<id>:<sha256-hex>" entries into identities; the hash is stored, never the token', () => {
    const { credentials, errors } = parseAdminCredentials(` alice:${hex('a')} , bob:${hex('b').toUpperCase()} `);
    expect(errors).toEqual([]);
    expect(credentials.map((c) => c.id)).toEqual(['alice', 'bob']);
    expect(credentials[0].hash.equals(hashAdminToken('a'))).toBe(true);
    expect(credentials[1].hash.equals(hashAdminToken('b'))).toBe(true);
  });

  it('drops malformed entries (a plaintext token where the hash belongs, a bad id) and reports them', () => {
    const { credentials, errors } = parseAdminCredentials(`alice:not-a-hash,:${hex('x')},bad id:${hex('y')},carol:${hex('c')}`);
    expect(credentials.map((c) => c.id)).toEqual(['carol']);
    expect(errors).toHaveLength(3);
  });

  it('a duplicated id or a shared token hash makes attribution ambiguous — every such entry is dropped', () => {
    const dupId = parseAdminCredentials(`alice:${hex('a')},alice:${hex('b')},bob:${hex('c')}`);
    expect(dupId.credentials.map((c) => c.id)).toEqual(['bob']);
    const dupHash = parseAdminCredentials(`alice:${hex('same')},bob:${hex('same')},carol:${hex('c')}`);
    expect(dupHash.credentials.map((c) => c.id)).toEqual(['carol']);
  });

  it('ADMIN_API_CREDENTIALS is authoritative: when every entry is malformed there are NO admins (no fallback to ADMIN_API_TOKEN)', () => {
    const loaded = loadAdminCredentials({ ADMIN_API_CREDENTIALS: 'alice:plaintext-token', ADMIN_API_TOKEN: 'shared' } as NodeJS.ProcessEnv);
    expect(loaded.mode).toBe('none');
    expect(loaded.set.size).toBe(0);
    expect(loaded.set.verify('shared', false)).toBeNull();
    expect(loaded.errors.length).toBeGreaterThan(0);
  });

  it('named credentials make the shared ADMIN_API_TOKEN inert', () => {
    const loaded = loadAdminCredentials({ ADMIN_API_CREDENTIALS: `alice:${hex('a')}`, ADMIN_API_TOKEN: 'shared' } as NodeJS.ProcessEnv);
    expect(loaded.mode).toBe('named');
    expect(loaded.set.verify('shared', false)).toBeNull();
    expect(loaded.set.verify('a', true)).toEqual({ id: 'alice', legacy: false });
    expect(loaded.warnings.join(' ')).toMatch(/ADMIN_API_TOKEN is ignored/);
  });

  it('the legacy shared ADMIN_API_TOKEN alone: accepted outside production as one identified credential, refused in production', () => {
    const loaded = loadAdminCredentials({ ADMIN_API_TOKEN: 'shared' } as NodeJS.ProcessEnv);
    expect(loaded.mode).toBe('legacy');
    expect(loaded.set.verify('shared', false)).toEqual({ id: LEGACY_ADMIN_ID, legacy: true });
    expect(loaded.set.verify('shared', true)).toBeNull();
    expect(loaded.set.usableCount(false)).toBe(1);
    expect(loaded.set.usableCount(true)).toBe(0);
  });

  it('nothing configured: no admins', () => {
    const loaded = loadAdminCredentials({} as NodeJS.ProcessEnv);
    expect(loaded.mode).toBe('none');
    expect(loaded.set.usableCount(false)).toBe(0);
  });
});
