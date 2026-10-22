// DB-free (shared verbatim by the simulation double, like crypto.ts) —
// error types of the persisted provider state (see provider-secrets.ts).

/**
 * A secret write was attempted with no SECRET_ENCRYPTION_KEY configured.
 * Gap register D13: this used to be a silent no-op — the admin API answered
 * 201 and nothing was stored. Now the write fails and nothing changes.
 */
export class SecretEncryptionKeyMissingError extends Error {
  readonly code = 'secret_encryption_key_missing';
  constructor(action: 'persist' | 'decrypt') {
    super(
      action === 'persist'
        ? 'SECRET_ENCRYPTION_KEY is not configured — provider secrets cannot be persisted, so the change was not applied.'
        : 'SECRET_ENCRYPTION_KEY is not configured — persisted provider secrets cannot be decrypted.',
    );
    this.name = 'SecretEncryptionKeyMissingError';
  }
}

/** Persisted secrets that exist but cannot be decrypted (wrong/rotated key, tampered row). */
export class ProviderSecretsDecryptError extends Error {
  readonly code = 'provider_secrets_decrypt_failed';
  constructor(readonly slug: string, cause: unknown) {
    super(
      `Persisted secrets for provider '${slug}' could not be decrypted ` +
        `(${cause instanceof Error ? cause.message : String(cause)}) — was SECRET_ENCRYPTION_KEY changed?`,
    );
    this.name = 'ProviderSecretsDecryptError';
  }
}
