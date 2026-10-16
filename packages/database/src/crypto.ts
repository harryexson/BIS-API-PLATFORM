import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash, timingSafeEqual } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

function getEncryptionKey(): Buffer {
  const passphrase = process.env.SECRET_ENCRYPTION_KEY;
  if (!passphrase) {
    throw new Error(
      'SECRET_ENCRYPTION_KEY environment variable is not set. ' +
        'Generate one with: openssl rand -hex 32',
    );
  }
  const salt = Buffer.from('bis-platform-salt-v1', 'utf-8');
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
}

export interface EncryptedPayload {
  encrypted: string;
  iv: string;
  tag: string;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encryptedBuffer = Buffer.from(payload.encrypted, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// Generic sha256 hash for high-entropy, single-use/revocable tokens
// (API keys, session tokens, verification tokens). Not for passwords —
// those are low-entropy user-chosen secrets and need hashPassword's
// salted/slow scrypt derivation instead.
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function hashApiKey(rawKey: string): string {
  return hashToken(rawKey);
}

export function generateApiKeyPrefix(): string {
  return 'bap_' + (process.env.NODE_ENV === 'production' ? 'live' : 'test');
}

export function generateApiKey(): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const raw = randomBytes(32).toString('hex');
  const hash = hashApiKey(raw);
  const prefix = generateApiKeyPrefix() + '_' + raw.substring(0, 8);
  return { raw, hash, prefix };
}

// ---------------------------------------------------------------------
// Password hashing (scrypt, random salt per password — not the fixed
// SECRET_ENCRYPTION_KEY salt used above, which is for a single shared
// server-side key, not per-user secrets).
// ---------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(password, salt, expected.length, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------
// Session tokens (login sessions) and verification tokens (email
// verification / password reset) — same shape as API keys: a random raw
// secret returned once, only its hash stored.
// ---------------------------------------------------------------------

export function generateSessionToken(): { raw: string; hash: string } {
  const raw = 'sess_' + randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

export function generateVerificationToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}
