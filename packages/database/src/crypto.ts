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

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
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

const PASSWORD_SCRYPT_COST = 16384;
const PASSWORD_KEY_LENGTH = 64;

/**
 * Hashes a password with scrypt and a random per-password salt, stored as
 * "salt:hash" hex so verification needs no separate lookup.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_KEY_LENGTH, { cost: PASSWORD_SCRYPT_COST });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length, { cost: PASSWORD_SCRYPT_COST });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
