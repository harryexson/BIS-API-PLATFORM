import { createHash, randomBytes } from 'node:crypto';
import type { ProviderStateStore } from '@company/providers';

/**
 * Phase 25 — shared fixtures for the SECRET_ENCRYPTION_KEY-loss drills
 * (secret-key-loss-*.postgres.integration.test.ts): the runbook procedure in
 * docs/operations/DISASTER_RECOVERY.md §4.2, walked through the REAL gateway
 * routes with a named Phase 20-21 admin credential against a REAL Postgres.
 */

/** The on-call admin's identity (ADMIN_API_CREDENTIALS entry id). */
export const ONCALL_ADMIN_ID = 'dr-oncall';

/** Fresh "openssl rand -hex 32" equivalents. */
export const newHexKey = () => randomBytes(32).toString('hex');

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Env for a gateway whose ONLY admin credential is one named, hashed entry (no legacy shared token). */
export function namedAdminEnv(token: string, secretEncryptionKey: string): Record<string, string> {
  return {
    ADMIN_API_CREDENTIALS: `${ONCALL_ADMIN_ID}:${sha256Hex(token)}`,
    SECRET_ENCRYPTION_KEY: secretEncryptionKey,
  };
}

/** Env keys the drills overwrite (restored afterwards). */
export const KEY_LOSS_ENV_KEYS = ['ADMIN_API_CREDENTIALS', 'ADMIN_API_TOKEN', 'SECRET_ENCRYPTION_KEY'] as const;

/**
 * The runbook's SQL (DISASTER_RECOVERY.md §4.2 step 2), verbatim except for
 * the deployment tier: production rows are 'live', these drills run in the
 * 'test' tier (NODE_ENV is not production).
 */
export const RUNBOOK_CLEAR_UNDECRYPTABLE_SECRETS_SQL = `UPDATE provider_configs
SET encrypted_secret = NULL, secret_iv = NULL, secret_tag = NULL, secrets_version = 0, updated_at = now()
WHERE environment = 'live' AND encrypted_secret IS NOT NULL;`;

export function clearUndecryptableSecretsSql(tier: 'live' | 'test'): string {
  return RUNBOOK_CLEAR_UNDECRYPTABLE_SECRETS_SQL.replace("environment = 'live'", `environment = '${tier}'`);
}

/** Two providers whose credentials an admin stored under the (soon to be lost) old key. */
export const SEEDED = [
  { slug: 'stripe', name: 'Stripe', category: 'payment', secrets: [{ field: 'api_key', label: 'Secret key', value: 'sk_test_p25_before_key_loss' }] },
  { slug: 'nmi', name: 'NMI', category: 'payment', secrets: [{ field: 'api_key', label: 'API key', value: 'nmi_p25_before_key_loss' }] },
] as const;

/** Persist SEEDED through the real Phase 15 store (encrypts under the CURRENT SECRET_ENCRYPTION_KEY). */
export async function seedProviderSecrets(store: ProviderStateStore): Promise<void> {
  for (const p of SEEDED) {
    const res = await store.saveSecrets({
      slug: p.slug,
      name: p.name,
      category: p.category,
      secrets: p.secrets.map((s) => ({ ...s })),
      expectedVersion: 0,
    });
    if (!res.saved) throw new Error(`seeding ${p.slug} secrets failed`);
  }
}
