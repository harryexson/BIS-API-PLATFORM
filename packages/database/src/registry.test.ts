import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApplicationRegistry,
  type ApplicationRepository,
  type ApiKeyRepository,
  type ApplicationRecord,
  type ApiKeyRecord,
  type CreateApplicationInput,
} from './registry';
import { hashApiKey } from './crypto';

interface MockApp extends ApplicationRecord {}
interface MockKey extends ApiKeyRecord {}

function createMockAppRepo(): ApplicationRepository & {
  _apps: MockApp[];
} {
  const apps: MockApp[] = [];
  return {
    _apps: apps,
    async findById(id) {
      return apps.find((a) => a.id === id);
    },
    async findBySlug(slug) {
      return apps.find((a) => a.slug === slug);
    },
    async findByName(name) {
      return apps.find((a) => a.name === name);
    },
    async create(data) {
      const app: MockApp = {
        id: 'app-' + String(apps.length + 1).padStart(3, '0'),
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        status: (data.status as string) ?? 'active',
        environment: (data.environment as string) ?? 'development',
        allowedCapabilities: data.allowedCapabilities ?? null,
        metadata: data.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      apps.push(app);
      return app;
    },
    async update(id, data) {
      const idx = apps.findIndex((a) => a.id === id);
      if (idx === -1) return undefined;
      apps[idx] = { ...apps[idx], ...data, updatedAt: new Date() };
      return apps[idx];
    },
  };
}

function createMockKeyRepo(): ApiKeyRepository & {
  _keys: MockKey[];
} {
  const keys: MockKey[] = [];
  return {
    _keys: keys,
    async findById(id) {
      return keys.find((k) => k.id === id);
    },
    async findByHash(keyHash) {
      return keys.find((k) => k.keyHash === keyHash);
    },
    async findByApplicationId(applicationId) {
      return keys
        .filter((k) => k.applicationId === applicationId)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
    },
    async create(data) {
      const key: MockKey = {
        id: 'key-' + String(keys.length + 1).padStart(3, '0'),
        applicationId: data.applicationId,
        keyHash: data.keyHash,
        prefix: data.prefix,
        environment: (data.environment as string) ?? 'development',
        scopes: data.scopes ?? null,
        lastUsedAt: null,
        expiresAt: data.expiresAt ?? null,
        revokedAt: null,
        createdAt: new Date(),
      };
      keys.push(key);
      return key;
    },
    async revoke(id) {
      const key = keys.find((k) => k.id === id);
      if (!key) return undefined;
      key.revokedAt = new Date();
      return key;
    },
    async updateLastUsed(id) {
      const key = keys.find((k) => k.id === id);
      if (key) key.lastUsedAt = new Date();
    },
  };
}

describe('ApplicationRegistry', () => {
  let appRepo: ReturnType<typeof createMockAppRepo>;
  let keyRepo: ReturnType<typeof createMockKeyRepo>;
  let registry: ApplicationRegistry;

  beforeEach(() => {
    appRepo = createMockAppRepo();
    keyRepo = createMockKeyRepo();
    registry = new ApplicationRegistry(appRepo, keyRepo);
  });

  describe('createApplication', () => {
    it('creates application with default API key', async () => {
      const result = await registry.createApplication({
        name: 'Test App',
        slug: 'test-app',
      });

      expect(result.application.name).toBe('Test App');
      expect(result.application.slug).toBe('test-app');
      expect(result.application.status).toBe('active');
      expect(result.application.environment).toBe('development');
      expect(result.apiKey.raw).toBeTruthy();
      expect(result.apiKey.raw.length).toBeGreaterThan(10);
      expect(result.apiKey.hash).toBe(hashApiKey(result.apiKey.raw));
      expect(result.apiKey.prefix).toMatch(/^bap_test_/);
    });

    it('creates application with custom environment', async () => {
      const result = await registry.createApplication({
        name: 'Prod App',
        slug: 'prod-app',
        environment: 'production',
      });

      expect(result.application.environment).toBe('production');
      expect(result.apiKey.environment).toBe('production');
    });

    it('creates application with allowed capabilities', async () => {
      const caps = ['payments:read', 'payments:write', 'messaging:send'];
      const result = await registry.createApplication({
        name: 'Capable App',
        slug: 'capable-app',
        allowedCapabilities: caps,
      });

      expect(result.application.allowedCapabilities).toEqual(caps);
    });

    it('rejects duplicate application name', async () => {
      await registry.createApplication({
        name: 'Existing App',
        slug: 'existing-app',
      });

      await expect(
        registry.createApplication({
          name: 'Existing App',
          slug: 'existing-app-2',
        }),
      ).rejects.toThrow('Application with name "Existing App" already exists');
    });

    it('rejects duplicate application slug', async () => {
      await registry.createApplication({
        name: 'App One',
        slug: 'my-slug',
      });

      await expect(
        registry.createApplication({
          name: 'App Two',
          slug: 'my-slug',
        }),
      ).rejects.toThrow('Application with slug "my-slug" already exists');
    });

    it('stores API key hash, not raw key', async () => {
      const result = await registry.createApplication({
        name: 'Hash Test',
        slug: 'hash-test',
      });

      const storedKey = keyRepo._keys.find(
        (k) => k.applicationId === result.application.id,
      );
      expect(storedKey).toBeDefined();
      expect(storedKey!.keyHash).toBe(hashApiKey(result.apiKey.raw));
      expect(storedKey!.keyHash).not.toBe(result.apiKey.raw);
    });
  });

  describe('authenticateApplication', () => {
    it('valid application → accepted', async () => {
      const { apiKey, application } = await registry.createApplication({
        name: 'Auth Test',
        slug: 'auth-test',
      });

      const result = await registry.authenticateApplication(apiKey.raw);
      expect(result.authenticated).toBe(true);
      expect(result.application?.id).toBe(application.id);
      expect(result.error).toBeUndefined();
    });

    it('invalid application → rejected', async () => {
      const result = await registry.authenticateApplication(
        'nonexistent_key_12345',
      );
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid API key');
      expect(result.application).toBeUndefined();
    });

    it('revoked key → rejected', async () => {
      const { apiKey } = await registry.createApplication({
        name: 'Revoke Test',
        slug: 'revoke-test',
      });

      await registry.revokeApplicationKey(apiKey.id);

      const result = await registry.authenticateApplication(apiKey.raw);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('API key has been revoked');
    });

    it('application A cannot use application B credentials', async () => {
      const appA = await registry.createApplication({
        name: 'App A',
        slug: 'app-a',
      });
      const appB = await registry.createApplication({
        name: 'App B',
        slug: 'app-b',
      });

      const resultA = await registry.authenticateApplication(
        appA.apiKey.raw,
      );
      expect(resultA.authenticated).toBe(true);
      expect(resultA.application?.id).toBe(appA.application.id);

      const resultB = await registry.authenticateApplication(
        appB.apiKey.raw,
      );
      expect(resultB.authenticated).toBe(true);
      expect(resultB.application?.id).toBe(appB.application.id);

      expect(resultA.application?.id).not.toBe(resultB.application?.id);
    });

    it('empty key → rejected', async () => {
      const result = await registry.authenticateApplication('');
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('API key is required');
    });

    it('expired key → rejected', async () => {
      const { apiKey } = await registry.createApplication({
        name: 'Expiry Test',
        slug: 'expiry-test',
      });

      const keyRecord = keyRepo._keys.find(
        (k) => k.applicationId !== undefined,
      );
      if (keyRecord) {
        keyRecord.expiresAt = new Date('2020-01-01');
      }

      const result = await registry.authenticateApplication(apiKey.raw);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('API key has expired');
    });

    it('wrong environment → rejected', async () => {
      const { apiKey } = await registry.createApplication({
        name: 'Env Test',
        slug: 'env-test',
        environment: 'development',
      });

      const result = await registry.authenticateApplication(
        apiKey.raw,
        'production',
      );
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe(
        'API key is not valid for "production" environment',
      );
    });

    it('inactive application → rejected', async () => {
      const { apiKey, application } = await registry.createApplication({
        name: 'Inactive Test',
        slug: 'inactive-test',
      });

      await appRepo.update(application.id, { status: 'suspended' });

      const result = await registry.authenticateApplication(apiKey.raw);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe(
        'Application is in "suspended" status',
      );
    });

    it('updates lastUsedAt on successful auth', async () => {
      const { apiKey } = await registry.createApplication({
        name: 'LastUsed Test',
        slug: 'lastused-test',
      });

      await registry.authenticateApplication(apiKey.raw);

      const keyRecord = keyRepo._keys.find(
        (k) => k.applicationId !== undefined,
      );
      expect(keyRecord?.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  describe('rotateApplicationKey', () => {
    it('revokes old key and creates new one', async () => {
      const { apiKey, application } = await registry.createApplication({
        name: 'Rotate Test',
        slug: 'rotate-test',
      });

      const result = await registry.rotateApplicationKey(application.id);
      expect(result.revoked.id).toBe(apiKey.id);
      expect(result.revoked.revokedAt).toBeInstanceOf(Date);
      expect(result.newKey.raw).toBeTruthy();
      expect(result.newKey.raw).not.toBe(apiKey.raw);
      expect(result.newKey.hash).toBe(hashApiKey(result.newKey.raw));
    });

    it('old key is rejected after rotation', async () => {
      const { apiKey, application } = await registry.createApplication({
        name: 'Rotate Reject',
        slug: 'rotate-reject',
      });

      await registry.rotateApplicationKey(application.id);

      const authResult = await registry.authenticateApplication(apiKey.raw);
      expect(authResult.authenticated).toBe(false);
      expect(authResult.error).toBe('API key has been revoked');
    });

    it('new key authenticates successfully', async () => {
      const { application } = await registry.createApplication({
        name: 'Rotate Auth',
        slug: 'rotate-auth',
      });

      const { newKey } = await registry.rotateApplicationKey(application.id);

      const authResult = await registry.authenticateApplication(newKey.raw);
      expect(authResult.authenticated).toBe(true);
      expect(authResult.application?.id).toBe(application.id);
    });

    it('throws for non-existent application', async () => {
      await expect(
        registry.rotateApplicationKey('nonexistent'),
      ).rejects.toThrow('Application nonexistent not found');
    });

    it('throws for suspended application', async () => {
      const { application } = await registry.createApplication({
        name: 'Suspended Rotate',
        slug: 'suspended-rotate',
      });

      await appRepo.update(application.id, { status: 'suspended' });

      await expect(
        registry.rotateApplicationKey(application.id),
      ).rejects.toThrow(
        'Cannot rotate key for application in "suspended" status',
      );
    });

    it('preserves scopes on rotation', async () => {
      const { application } = await registry.createApplication({
        name: 'Scope Rotate',
        slug: 'scope-rotate',
      });

      const keyRecord = keyRepo._keys.find(
        (k) => k.applicationId === application.id,
      );
      if (keyRecord) {
        keyRecord.scopes = 'payments:read,messaging:send';
      }

      const result = await registry.rotateApplicationKey(application.id);

      const newKeyRecord = keyRepo._keys.find(
        (k) =>
          k.applicationId === application.id && k.id === result.newKey.id,
      );
      expect(newKeyRecord?.scopes).toBe('payments:read,messaging:send');
    });
  });

  describe('revokeApplicationKey', () => {
    it('revokes an active key', async () => {
      const { apiKey } = await registry.createApplication({
        name: 'Revoke Active',
        slug: 'revoke-active',
      });

      const revoked = await registry.revokeApplicationKey(apiKey.id);
      expect(revoked.revokedAt).toBeInstanceOf(Date);
      expect(revoked.id).toBe(apiKey.id);
    });

    it('throws for already revoked key', async () => {
      const { apiKey } = await registry.createApplication({
        name: 'Already Revoked',
        slug: 'already-revoked',
      });

      await registry.revokeApplicationKey(apiKey.id);

      await expect(
        registry.revokeApplicationKey(apiKey.id),
      ).rejects.toThrow('already revoked');
    });

    it('throws for non-existent key', async () => {
      await expect(
        registry.revokeApplicationKey('nonexistent'),
      ).rejects.toThrow('API key nonexistent not found');
    });
  });

  describe('createApplication — 6 confirmed apps', () => {
    it('all 6 confirmed apps can be created', async () => {
      const apps = [
        { name: 'Reach Church MS', slug: 'reach-church-ms' },
        { name: 'Afribook', slug: 'afribook' },
        { name: 'HaulPro', slug: 'haulpro' },
        { name: 'STAYSCAPE', slug: 'stayscape' },
        { name: 'EventHub Pro', slug: 'eventhub-pro' },
        { name: 'Ride-ly', slug: 'ride-ly' },
      ];

      for (const app of apps) {
        const result = await registry.createApplication(app);
        expect(result.application.name).toBe(app.name);
        expect(result.application.slug).toBe(app.slug);
        expect(result.apiKey.raw).toBeTruthy();
      }

      expect(appRepo._apps).toHaveLength(6);
    });
  });
});
