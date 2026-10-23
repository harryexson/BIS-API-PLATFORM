import { createHash, timingSafeEqual } from 'node:crypto';

// ----------------------------------------------------
// ADMIN CREDENTIALS (Phase 20-21, gap register C7 / PHASE14-06)
// ----------------------------------------------------
// Admin requests used to be authorised by comparing one shared
// ADMIN_API_TOKEN with `!==` (not constant-time), also accepted from a
// `?token=` query string, and nothing recorded WHO made a request — every
// administrator held the same secret.
//
// Now every administrator has their OWN named credential:
//
//   ADMIN_API_CREDENTIALS="alice:<sha256-hex>,bob:<sha256-hex>"
//
// where <sha256-hex> is the lowercase hex SHA-256 of that admin's token.
// Only the hash is configured — the gateway never holds a plaintext admin
// token. To mint one:
//
//   TOKEN=$(openssl rand -hex 32)          # give this to the admin, once
//   printf %s "$TOKEN" | sha256sum         # put "<id>:<this hash>" in config
//
// Revoking an admin = removing their entry (config change + restart).
//
// Comparison: the presented token is SHA-256 hashed and compared with
// crypto.timingSafeEqual against EVERY configured hash — always 32-byte
// buffers (so no length is leaked and timingSafeEqual can never throw on a
// length mismatch), and the loop never exits early on a match.
//
// Legacy ADMIN_API_TOKEN (one shared, unidentified secret) is still accepted
// OUTSIDE production only (local development, existing test suites), as the
// identity 'legacy-admin-token'. In production it is refused: a production
// deployment must configure ADMIN_API_CREDENTIALS, or admin auth answers 503.

export const LEGACY_ADMIN_ID = 'legacy-admin-token';

/** Query-string names a client might put an admin token in. Always refused. */
export const ADMIN_TOKEN_QUERY_PARAMS = ['token', 'adminToken', 'admin_token', 'x-admin-token', 'access_token'] as const;

/** Longest token accepted for hashing (anything longer is refused unhashed). */
export const MAX_ADMIN_TOKEN_LENGTH = 1024;

const ADMIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface AdminCredential {
  /** Stable, human-meaningful identity recorded on every audited action. */
  id: string;
  /** SHA-256 of the token (32 bytes). */
  hash: Buffer;
  /** The legacy shared ADMIN_API_TOKEN — never accepted in production. */
  legacy: boolean;
}

export interface AdminIdentity {
  id: string;
  legacy: boolean;
}

export function hashAdminToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Parses ADMIN_API_CREDENTIALS. A malformed entry is reported and DROPPED
 * (never accepted in some guessed form); a duplicated id or hash drops every
 * entry sharing it, since either would make attribution ambiguous.
 */
export function parseAdminCredentials(raw: string | undefined): { credentials: AdminCredential[]; errors: string[] } {
  const errors: string[] = [];
  if (!raw || raw.trim() === '') return { credentials: [], errors };

  const parsed: Array<{ id: string; hex: string }> = [];
  raw.split(',').map((e) => e.trim()).filter(Boolean).forEach((entry, i) => {
    const sep = entry.indexOf(':');
    const id = sep > 0 ? entry.slice(0, sep).trim() : '';
    const hex = sep > 0 ? entry.slice(sep + 1).trim().toLowerCase() : '';
    if (!ADMIN_ID_PATTERN.test(id)) {
      errors.push(`entry ${i + 1}: admin id must match ${ADMIN_ID_PATTERN} (format "<id>:<sha256-hex>")`);
      return;
    }
    if (!SHA256_HEX_PATTERN.test(hex)) {
      errors.push(`entry ${i + 1} (${id}): expected the 64-hex-character SHA-256 of the token, not the token itself`);
      return;
    }
    parsed.push({ id, hex });
  });

  const count = (key: 'id' | 'hex', v: string) => parsed.filter((p) => p[key] === v).length;
  const credentials: AdminCredential[] = [];
  for (const p of parsed) {
    if (count('id', p.id) > 1) {
      errors.push(`admin id '${p.id}' is configured more than once — all of its entries are ignored`);
      continue;
    }
    if (count('hex', p.hex) > 1) {
      errors.push(`admin '${p.id}' shares a token hash with another admin — both entries are ignored`);
      continue;
    }
    credentials.push({ id: p.id, hash: Buffer.from(p.hex, 'hex'), legacy: false });
  }
  // A duplicate is reported once per offending entry; keep the messages unique.
  return { credentials, errors: [...new Set(errors)] };
}

export type AdminAuthMode = 'named' | 'legacy' | 'none';

export interface LoadedAdminCredentials {
  set: AdminCredentialSet;
  mode: AdminAuthMode;
  errors: string[];
  warnings: string[];
}

/**
 * Builds the credential set the gateway authenticates admins against.
 * ADMIN_API_CREDENTIALS, when set, is authoritative — if every entry in it is
 * malformed there are NO admin credentials (fail closed); it never silently
 * falls back to the shared ADMIN_API_TOKEN.
 */
export function loadAdminCredentials(env: NodeJS.ProcessEnv = process.env): LoadedAdminCredentials {
  const warnings: string[] = [];
  const rawNamed = env.ADMIN_API_CREDENTIALS;
  const legacyToken = env.ADMIN_API_TOKEN;

  if (rawNamed && rawNamed.trim() !== '') {
    const { credentials, errors } = parseAdminCredentials(rawNamed);
    if (legacyToken) warnings.push('ADMIN_API_TOKEN is ignored because ADMIN_API_CREDENTIALS is set');
    return { set: new AdminCredentialSet(credentials), mode: credentials.length > 0 ? 'named' : 'none', errors, warnings };
  }
  if (legacyToken) {
    warnings.push(
      'ADMIN_API_TOKEN is a single shared admin secret with no identity — accepted outside production only; configure ADMIN_API_CREDENTIALS',
    );
    return {
      set: new AdminCredentialSet([{ id: LEGACY_ADMIN_ID, hash: hashAdminToken(legacyToken), legacy: true }]),
      mode: 'legacy',
      errors: [],
      warnings,
    };
  }
  return { set: new AdminCredentialSet([]), mode: 'none', errors: [], warnings };
}

type Equal = (a: Buffer, b: Buffer) => boolean;

export class AdminCredentialSet {
  /**
   * `equal` is only injectable so tests can observe that the comparison is
   * made once per credential on fixed-length buffers; production always uses
   * crypto.timingSafeEqual.
   */
  constructor(
    private readonly credentials: AdminCredential[],
    private readonly equal: Equal = timingSafeEqual,
  ) {}

  get size(): number {
    return this.credentials.length;
  }

  /** Credentials usable in this environment (legacy is never usable in production). */
  usableCount(production: boolean): number {
    return this.credentials.filter((c) => !(production && c.legacy)).length;
  }

  /**
   * The credential this token belongs to, or null. Constant-time with
   * respect to the token's content and length and to WHICH credential (if
   * any) matches: one SHA-256, then one 32-byte timingSafeEqual per
   * configured credential, no early exit.
   */
  verify(token: string, production: boolean): AdminIdentity | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ADMIN_TOKEN_LENGTH) return null;
    const presented = hashAdminToken(token);
    let match: AdminCredential | null = null;
    for (const cred of this.credentials) {
      const same = this.equal(presented, cred.hash);
      if (same && match === null) match = cred;
    }
    if (!match || (production && match.legacy)) return null;
    return { id: match.id, legacy: match.legacy };
  }
}
