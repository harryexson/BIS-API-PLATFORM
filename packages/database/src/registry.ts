import type {
  Application,
  NewApplication,
  ApplicationApiKey,
  NewApplicationApiKey,
} from './schema';
import { hashApiKey, generateApiKey } from './crypto';

export interface ApplicationRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  environment: string;
  allowedCapabilities: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  applicationId: string;
  keyHash: string;
  prefix: string;
  environment: string;
  scopes: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateApplicationInput {
  name: string;
  slug: string;
  description?: string;
  status?: string;
  environment?: string;
  allowedCapabilities?: unknown;
  metadata?: unknown;
}

export interface CreateApplicationOutput {
  application: ApplicationRecord;
  apiKey: {
    id: string;
    raw: string;
    hash: string;
    prefix: string;
    environment: string;
  };
}

export interface AuthenticateResult {
  authenticated: boolean;
  application?: ApplicationRecord;
  error?: string;
}

export interface RotateKeyResult {
  revoked: ApiKeyRecord;
  newKey: {
    id: string;
    raw: string;
    hash: string;
    prefix: string;
    environment: string;
  };
}

export interface ApplicationRepository {
  findById(id: string): Promise<ApplicationRecord | undefined>;
  findBySlug(slug: string): Promise<ApplicationRecord | undefined>;
  findByName(name: string): Promise<ApplicationRecord | undefined>;
  create(data: NewApplication): Promise<ApplicationRecord>;
  update(
    id: string,
    data: Partial<NewApplication>,
  ): Promise<ApplicationRecord | undefined>;
}

export interface ApiKeyRepository {
  findById(id: string): Promise<ApiKeyRecord | undefined>;
  findByHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  findByApplicationId(applicationId: string): Promise<ApiKeyRecord[]>;
  create(data: NewApplicationApiKey): Promise<ApiKeyRecord>;
  revoke(id: string): Promise<ApiKeyRecord | undefined>;
  updateLastUsed(id: string): Promise<void>;
}

export class ApplicationRegistry {
  constructor(
    private readonly appRepo: ApplicationRepository,
    private readonly keyRepo: ApiKeyRepository,
  ) {}

  async createApplication(
    input: CreateApplicationInput,
  ): Promise<CreateApplicationOutput> {
    const existingByName = await this.appRepo.findByName(input.name);
    if (existingByName) {
      throw new Error(`Application with name "${input.name}" already exists`);
    }

    const existingBySlug = await this.appRepo.findBySlug(input.slug);
    if (existingBySlug) {
      throw new Error(`Application with slug "${input.slug}" already exists`);
    }

    const application = await this.appRepo.create({
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      status: input.status ?? 'active',
      environment: input.environment ?? 'development',
      allowedCapabilities: input.allowedCapabilities ?? null,
      metadata: input.metadata ?? null,
    });

    const { raw, hash, prefix } = generateApiKey();

    const apiKey = await this.keyRepo.create({
      applicationId: application.id,
      keyHash: hash,
      prefix,
      environment: application.environment,
      scopes: null,
    });

    return {
      application,
      apiKey: {
        id: apiKey.id,
        raw,
        hash,
        prefix,
        environment: apiKey.environment,
      },
    };
  }

  async rotateApplicationKey(
    applicationId: string,
    environment?: string,
  ): Promise<RotateKeyResult> {
    const application = await this.appRepo.findById(applicationId);
    if (!application) {
      throw new Error(`Application ${applicationId} not found`);
    }

    if (application.status !== 'active') {
      throw new Error(
        `Cannot rotate key for application in "${application.status}" status`,
      );
    }

    const activeKeys = await this.keyRepo.findByApplicationId(applicationId);
    const currentKey = activeKeys.find((k) => !k.revokedAt);

    if (!currentKey) {
      throw new Error('No active key found to rotate');
    }

    const revoked = await this.keyRepo.revoke(currentKey.id);
    if (!revoked) {
      throw new Error('Failed to revoke current API key');
    }

    const keyEnvironment = environment ?? application.environment;
    const { raw, hash, prefix } = generateApiKey();

    const newKey = await this.keyRepo.create({
      applicationId,
      keyHash: hash,
      prefix,
      environment: keyEnvironment,
      scopes: currentKey.scopes,
    });

    return {
      revoked,
      newKey: {
        id: newKey.id,
        raw,
        hash,
        prefix,
        environment: newKey.environment,
      },
    };
  }

  async revokeApplicationKey(keyId: string): Promise<ApiKeyRecord> {
    const key = await this.keyRepo.findById(keyId);
    if (!key) {
      throw new Error(`API key ${keyId} not found`);
    }

    if (key.revokedAt) {
      throw new Error(`API key ${keyId} is already revoked`);
    }

    const revoked = await this.keyRepo.revoke(keyId);
    if (!revoked) {
      throw new Error(`Failed to revoke API key ${keyId}`);
    }

    return revoked;
  }

  async authenticateApplication(
    rawKey: string,
    environment?: string,
  ): Promise<AuthenticateResult> {
    if (!rawKey || rawKey.length === 0) {
      return { authenticated: false, error: 'API key is required' };
    }

    const keyHash = hashApiKey(rawKey);
    const apiKey = await this.keyRepo.findByHash(keyHash);

    if (!apiKey) {
      return { authenticated: false, error: 'Invalid API key' };
    }

    if (apiKey.revokedAt) {
      return { authenticated: false, error: 'API key has been revoked' };
    }

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      return { authenticated: false, error: 'API key has expired' };
    }

    if (environment && apiKey.environment !== environment) {
      return {
        authenticated: false,
        error: `API key is not valid for "${environment}" environment`,
      };
    }

    const application = await this.appRepo.findById(apiKey.applicationId);
    if (!application) {
      return {
        authenticated: false,
        error: 'Application not found for this API key',
      };
    }

    if (application.status !== 'active') {
      return {
        authenticated: false,
        error: `Application is in "${application.status}" status`,
      };
    }

    await this.keyRepo.updateLastUsed(apiKey.id);

    return { authenticated: true, application };
  }
}
