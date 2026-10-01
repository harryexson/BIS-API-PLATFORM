/**
 * Master plan Phase 26 (configuration validation). Misconfiguration
 * currently surfaces at request time — e.g. every webhook gets rejected
 * with 503 if WEBHOOK_HMAC_SECRET is unset, every DB call throws if
 * DATABASE_URL is unset — which is fail-closed and safe, but a deployment
 * can run for a while looking "up" before the first request that exposes
 * the problem. This moves the same checks to process startup so a bad
 * deployment fails immediately and loudly instead of degrading silently.
 *
 * Deliberately NOT included: REDIS_URL. The rate limiter and job store
 * both already fall back to an in-memory implementation when it's unset
 * (packages/workers/src/client.ts, services/api-gateway/src/auth.ts) —
 * that's a legitimate (if reduced-durability) deployment choice today,
 * not a misconfiguration to fail boot over.
 */
export interface StartupConfigResult {
  ok: boolean;
  errors: string[];
}

export function validateStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
): StartupConfigResult {
  const errors: string[] = [];
  const isProduction = env.NODE_ENV === 'production';

  if (!env.DATABASE_URL) {
    errors.push(
      'DATABASE_URL is required (Neon/Postgres connection string) — every repository call fails without it.',
    );
  }

  if (isProduction) {
    if (!env.WEBHOOK_HMAC_SECRET) {
      errors.push(
        'WEBHOOK_HMAC_SECRET is required in production — without it every inbound webhook is rejected (fail-closed by design, but better caught at boot than discovered via a stream of 503s).',
      );
    }
    if (!env.SECRET_ENCRYPTION_KEY) {
      errors.push(
        'SECRET_ENCRYPTION_KEY is required in production — provider secret encryption/decryption fails without it.',
      );
    }
    if (!env.PLATFORM_ADMIN_KEY) {
      errors.push(
        'PLATFORM_ADMIN_KEY is required in production — without it every admin dashboard route rejects all requests (fail-closed by design, but the whole admin console becomes unusable, which is worth catching at boot).',
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validates startup configuration and exits the process with a clear
 * error if it's invalid. Call this once, early, from each service's
 * process entrypoint (not from app.ts / the Express app factory — tests
 * that import the app directly, e.g. the simulation harness, construct
 * their own environment and must not be forced through this check).
 */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const result = validateStartupConfig(env);
  if (!result.ok) {
    console.error('FATAL: invalid startup configuration —');
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}
