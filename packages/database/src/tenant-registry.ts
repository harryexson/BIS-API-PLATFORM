import type { NewTenant } from './schema';

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  countryCode: string | null;
  currency: string | null;
  status: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantLinkRecord {
  id: string;
  tenantId: string;
  applicationId: string;
  status: string;
  createdAt: Date;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  countryCode?: string;
  currency?: string;
  status?: string;
  metadata?: unknown;
}

export interface ResolveTenantResult {
  resolved: boolean;
  tenant?: TenantRecord;
  applicationId?: string;
  error?: string;
}

export interface TenantRepository {
  findById(id: string): Promise<TenantRecord | undefined>;
  findBySlug(slug: string): Promise<TenantRecord | undefined>;
  create(data: NewTenant): Promise<TenantRecord>;
  update(
    id: string,
    data: Partial<NewTenant>,
  ): Promise<TenantRecord | undefined>;
}

export interface TenantApplicationLinkRepository {
  findByTenantAndApplication(
    tenantId: string,
    applicationId: string,
  ): Promise<TenantLinkRecord | undefined>;
  isLinked(tenantId: string, applicationId: string): Promise<boolean>;
  link(tenantId: string, applicationId: string): Promise<TenantLinkRecord>;
  unlink(tenantId: string, applicationId: string): Promise<boolean>;
}

export interface TenantAccessContext {
  tenantId: string;
  applicationId: string;
}

export class TenantRegistry {
  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly linkRepo: TenantApplicationLinkRepository,
  ) {}

  async createTenant(input: CreateTenantInput): Promise<TenantRecord> {
    const existing = await this.tenantRepo.findBySlug(input.slug);
    if (existing) {
      throw new Error(`Tenant with slug "${input.slug}" already exists`);
    }

    return this.tenantRepo.create({
      name: input.name,
      slug: input.slug,
      countryCode: input.countryCode ?? null,
      currency: input.currency ?? null,
      status: input.status ?? 'active',
      metadata: input.metadata ?? null,
    });
  }

  async linkTenantToApplication(
    tenantId: string,
    applicationId: string,
  ): Promise<TenantLinkRecord> {
    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    if (tenant.status !== 'active') {
      throw new Error(
        `Cannot link tenant in "${tenant.status}" status`,
      );
    }

    return this.linkRepo.link(tenantId, applicationId);
  }

  async unlinkTenantFromApplication(
    tenantId: string,
    applicationId: string,
  ): Promise<boolean> {
    return this.linkRepo.unlink(tenantId, applicationId);
  }

  async resolveTenant(
    applicationId: string,
    tenantSlug: string,
  ): Promise<ResolveTenantResult> {
    const tenant = await this.tenantRepo.findBySlug(tenantSlug);
    if (!tenant) {
      return { resolved: false, error: `Tenant "${tenantSlug}" not found` };
    }

    if (tenant.status !== 'active') {
      return {
        resolved: false,
        error: `Tenant "${tenantSlug}" is in "${tenant.status}" status`,
      };
    }

    const linked = await this.linkRepo.isLinked(tenant.id, applicationId);
    if (!linked) {
      return {
        resolved: false,
        error: `Tenant "${tenantSlug}" is not linked to this application`,
      };
    }

    return { resolved: true, tenant, applicationId };
  }

  async requireTenant(
    applicationId: string,
    tenantSlug: string,
  ): Promise<TenantAccessContext> {
    const result = await this.resolveTenant(applicationId, tenantSlug);
    if (!result.resolved) {
      throw new Error(result.error);
    }
    return {
      tenantId: result.tenant!.id,
      applicationId,
    };
  }

  async assertTenantAccess(
    applicationId: string,
    tenantId: string,
  ): Promise<void> {
    const linked = await this.linkRepo.isLinked(tenantId, applicationId);
    if (!linked) {
      throw new Error(
        `Access denied: tenant ${tenantId} is not linked to application ${applicationId}`,
      );
    }
  }
}
