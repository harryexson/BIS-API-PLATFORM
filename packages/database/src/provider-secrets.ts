import { providerRepository } from './repositories/providers';
import { providerConfigRepository } from './repositories/provider-configs';
import { encryptSecret, decryptSecret } from './crypto';

// Persists/restores ProviderRegistry's (packages/providers) in-memory
// secrets across a restart, without packages/providers itself depending on
// @company/database — see docs/IMPLEMENTATION_CHANGELOG.md's entry for
// this pass. The caller (services/api-gateway) owns both packages already
// and is the only place this needs to be wired.
//
// One config row per (provider, deployment tier) — 'live' in production,
// 'test' everywhere else — not per the provider's own 'live'/'test'
// ManagementState.environment field, which an admin can change at runtime;
// keying by deployment tier avoids secrets silently becoming unreachable
// if that admin-controlled value changes mid-life.
export function currentDeploymentTier(): 'live' | 'test' {
  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
}

export interface PersistableSecret {
  field: string;
  label: string;
  value: string;
}

// A provider not yet backed by a `providers` row (see upsertBySlug) has
// nothing to persist against yet — the caller is expected to call this
// once per known provider id at startup, which both seeds the row and
// makes every later persist/load call for that id resolvable.
export async function ensureProviderRow(input: {
  slug: string;
  name: string;
  category: string;
}): Promise<string> {
  const row = await providerRepository.upsertBySlug({
    slug: input.slug,
    name: input.name,
    category: input.category,
  });
  return row.id;
}

// Encrypts and stores the FULL current secrets set for one provider as a
// single blob (not an incremental diff) — mirrors how ProviderRegistry's
// own syncSecrets() rebuilds the adapter's in-memory record from scratch
// on every change, so this stays trivially consistent with it. Silently
// no-ops (logged once by the caller, not here) when SECRET_ENCRYPTION_KEY
// isn't configured — persistence is a durability nice-to-have, not a
// request-blocking dependency; the in-memory registry state this mirrors
// is already correct either way.
export async function persistProviderSecrets(
  slug: string,
  secrets: PersistableSecret[],
): Promise<void> {
  if (!process.env.SECRET_ENCRYPTION_KEY) return;

  const provider = await providerRepository.findBySlug(slug);
  if (!provider) return;

  const environment = currentDeploymentTier();
  const payload = encryptSecret(JSON.stringify(secrets));

  const existing = await providerConfigRepository.findByProviderAndEnvironment(provider.id, environment);
  if (existing) {
    await providerConfigRepository.update(existing.id, {
      encryptedSecret: payload.encrypted,
      secretIv: payload.iv,
      secretTag: payload.tag,
    });
  } else {
    await providerConfigRepository.create({
      providerId: provider.id,
      environment,
      encryptedSecret: payload.encrypted,
      secretIv: payload.iv,
      secretTag: payload.tag,
    });
  }
}

// Returns every provider's persisted secrets for the current deployment
// tier, keyed by provider slug — one query per known `providers` row.
// A row that fails to decrypt (e.g. SECRET_ENCRYPTION_KEY rotated since it
// was written) is skipped, not thrown — one bad row must not block every
// other provider's secrets from loading at startup.
export async function loadAllProviderSecrets(): Promise<Record<string, PersistableSecret[]>> {
  if (!process.env.SECRET_ENCRYPTION_KEY) return {};

  const environment = currentDeploymentTier();
  const allProviders = await providerRepository.findAll();
  const snapshot: Record<string, PersistableSecret[]> = {};

  for (const provider of allProviders) {
    const config = await providerConfigRepository.findByProviderAndEnvironment(provider.id, environment);
    if (!config?.encryptedSecret || !config.secretIv || !config.secretTag) continue;

    try {
      const json = decryptSecret({
        encrypted: config.encryptedSecret,
        iv: config.secretIv,
        tag: config.secretTag,
      });
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) snapshot[provider.slug] = parsed;
    } catch (err) {
      console.error(`[provider-secrets] failed to decrypt secrets for '${provider.slug}' — skipping`, err);
    }
  }

  return snapshot;
}
