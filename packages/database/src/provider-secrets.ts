import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { getDb } from './connection';
import { providers, providerConfigs } from './schema';
import { providerRepository } from './repositories/providers';
import { encryptSecret, decryptSecret } from './crypto';
import { currentDeploymentTier } from './environment-tier';
import { SecretEncryptionKeyMissingError, ProviderSecretsDecryptError } from './provider-state-errors';

// Persisted provider state for packages/providers' ProviderRegistry —
// configuration AND secrets — without packages/providers itself depending
// on @company/database: the registry talks to the ProviderStateStore
// interface, which `providerStateStore` below implements (Phase 15, gap
// register E12/D13).
//
// One provider_configs row per (provider, deployment tier) — 'live' in
// production, 'test' everywhere else — not per the provider's own
// 'live'/'test' ManagementState.environment field, which an admin can
// change at runtime; keying by deployment tier avoids state silently
// becoming unreachable if that admin-controlled value changes mid-life.
export { currentDeploymentTier } from './environment-tier';
export { SecretEncryptionKeyMissingError, ProviderSecretsDecryptError } from './provider-state-errors';

// Any drizzle Postgres handle: production's neon-http one, or the
// postgres-js one the real-Postgres integration tests bind to (same SQL).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

export interface PersistableSecret {
  field: string;
  label: string;
  value: string;
  id?: string;
  lastUpdated?: string;
}

export interface ProviderStateRow {
  slug: string;
  managementVersion: number;
  management: unknown;
  secretsVersion: number;
  /** Throws SecretEncryptionKeyMissingError / ProviderSecretsDecryptError — never returns [] for an unreadable row. */
  readSecrets(): PersistableSecret[];
}

export type ProviderStateWrite = { saved: true; version: number } | { saved: false };

// A provider not yet backed by a `providers` row has nothing to persist
// against yet — upserted (atomic ON CONFLICT) the first time it's written.
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

/**
 * Factory so the exact same SQL runs against a real Postgres in tests.
 * Production code uses the `providerStateStore` singleton below.
 *
 * Both writes are ONE statement each (neon-http has no transactions):
 *   INSERT ... ON CONFLICT (provider_id, environment) DO UPDATE
 *     SET ..., <version> = <version> + 1
 *     WHERE <version> = <expected>
 *   RETURNING <version>
 * — a compare-and-set: no row back means another writer won the race.
 */
export function createProviderStateStore(dbProvider: () => AnyPgDb) {
  async function providerIdFor(slug: string, name: string, category: string): Promise<string> {
    const rows = await dbProvider()
      .insert(providers)
      .values({ slug, name, category })
      .onConflictDoUpdate({ target: providers.slug, set: { name, category, updatedAt: new Date() } })
      .returning({ id: providers.id });
    return rows[0].id;
  }

  async function selectRows(slug?: string) {
    const tier = currentDeploymentTier();
    return dbProvider()
      .select({
        slug: providers.slug,
        managementConfig: providerConfigs.managementConfig,
        managementVersion: providerConfigs.managementVersion,
        secretsVersion: providerConfigs.secretsVersion,
        encryptedSecret: providerConfigs.encryptedSecret,
        secretIv: providerConfigs.secretIv,
        secretTag: providerConfigs.secretTag,
      })
      .from(providerConfigs)
      .innerJoin(providers, eq(providers.id, providerConfigs.providerId))
      .where(
        slug
          ? and(eq(providerConfigs.environment, tier), eq(providers.slug, slug))
          : eq(providerConfigs.environment, tier),
      );
  }

  type Selected = Awaited<ReturnType<typeof selectRows>>[number];

  function toState(r: Selected): ProviderStateRow {
    return {
      slug: r.slug,
      managementVersion: r.managementVersion,
      management: r.managementConfig ?? null,
      secretsVersion: r.secretsVersion,
      readSecrets(): PersistableSecret[] {
        if (r.secretsVersion === 0 && !r.encryptedSecret) return [];
        if (!r.encryptedSecret || !r.secretIv || !r.secretTag) {
          throw new ProviderSecretsDecryptError(r.slug, new Error('encrypted secrets row is incomplete'));
        }
        if (!process.env.SECRET_ENCRYPTION_KEY) throw new SecretEncryptionKeyMissingError('decrypt');
        let parsed: unknown;
        try {
          parsed = JSON.parse(decryptSecret({ encrypted: r.encryptedSecret, iv: r.secretIv, tag: r.secretTag }));
        } catch (err) {
          throw new ProviderSecretsDecryptError(r.slug, err);
        }
        if (!Array.isArray(parsed)) throw new ProviderSecretsDecryptError(r.slug, new Error('decrypted payload is not a list'));
        return parsed as PersistableSecret[];
      },
    };
  }

  return {
    async loadAll(): Promise<ProviderStateRow[]> {
      return (await selectRows()).map(toState);
    },

    async load(slug: string): Promise<ProviderStateRow | null> {
      const rows = await selectRows(slug);
      return rows[0] ? toState(rows[0]) : null;
    },

    async saveManagement(input: {
      slug: string;
      name: string;
      category: string;
      management: object;
      expectedVersion: number;
    }): Promise<ProviderStateWrite> {
      const providerId = await providerIdFor(input.slug, input.name, input.category);
      const document = input.management as Record<string, unknown>;
      const rows = await dbProvider()
        .insert(providerConfigs)
        .values({
          providerId,
          environment: currentDeploymentTier(),
          managementConfig: document,
          managementVersion: input.expectedVersion + 1,
        })
        .onConflictDoUpdate({
          target: [providerConfigs.providerId, providerConfigs.environment],
          set: {
            managementConfig: document,
            managementVersion: sql`${providerConfigs.managementVersion} + 1`,
            updatedAt: new Date(),
          },
          setWhere: sql`${providerConfigs.managementVersion} = ${input.expectedVersion}`,
        })
        .returning({ version: providerConfigs.managementVersion });
      return rows[0] ? { saved: true, version: rows[0].version } : { saved: false };
    },

    async saveSecrets(input: {
      slug: string;
      name: string;
      category: string;
      secrets: PersistableSecret[];
      expectedVersion: number;
    }): Promise<ProviderStateWrite> {
      // D13: never a silent no-op — refuse before touching anything.
      if (!process.env.SECRET_ENCRYPTION_KEY) throw new SecretEncryptionKeyMissingError('persist');
      const payload = encryptSecret(JSON.stringify(input.secrets));
      const providerId = await providerIdFor(input.slug, input.name, input.category);
      const rows = await dbProvider()
        .insert(providerConfigs)
        .values({
          providerId,
          environment: currentDeploymentTier(),
          encryptedSecret: payload.encrypted,
          secretIv: payload.iv,
          secretTag: payload.tag,
          secretsVersion: input.expectedVersion + 1,
        })
        .onConflictDoUpdate({
          target: [providerConfigs.providerId, providerConfigs.environment],
          set: {
            encryptedSecret: payload.encrypted,
            secretIv: payload.iv,
            secretTag: payload.tag,
            secretsVersion: sql`${providerConfigs.secretsVersion} + 1`,
            updatedAt: new Date(),
          },
          setWhere: sql`${providerConfigs.secretsVersion} = ${input.expectedVersion}`,
        })
        .returning({ version: providerConfigs.secretsVersion });
      return rows[0] ? { saved: true, version: rows[0].version } : { saved: false };
    },
  };
}

export type ProviderStateStoreImpl = ReturnType<typeof createProviderStateStore>;

export const providerStateStore: ProviderStateStoreImpl = createProviderStateStore(
  () => getDb() as unknown as AnyPgDb,
);
