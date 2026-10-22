// DB-free (no connection import) so the simulation double can share it
// verbatim, like crypto.ts and transaction-status.ts.

export type DeploymentTier = 'live' | 'test';

/**
 * The tier this deployment's provider traffic runs in: 'live' in
 * production (real credentials, real money — routing only ever selects
 * 'live'-environment providers there), 'test' everywhere else.
 */
export function currentDeploymentTier(): DeploymentTier {
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

/**
 * The tier an API key / application `environment` value belongs to. Two
 * vocabularies are in use for the same idea — 'live'/'test' (portal-issued
 * keys) and 'production'/'development' (applications, and keys created
 * with them) — so they are compared by tier, never as raw strings. Anything
 * not explicitly live is test: an unknown value must never unlock live
 * traffic.
 */
export function environmentTier(environment: string | null | undefined): DeploymentTier {
  return environment === 'live' || environment === 'production' ? 'live' : 'test';
}
