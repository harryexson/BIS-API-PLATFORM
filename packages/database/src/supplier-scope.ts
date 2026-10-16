/**
 * Supplier ownership verification — the Application → Tenant → Supplier
 * chain that keeps supplier A (an Afribook vendor, a STAYSCAPE host) from
 * acting as supplier B.
 *
 * Phase 7 (gap register F3.8). The previous version of this file:
 *   - imported from '@company/database' (i.e. from its own package — a
 *     circular self-import) and was never exported, so nothing called it;
 *   - compared `supplier.applicationId` (a UUID FK to applications.id)
 *     against the gateway's `appId`, which is the application's SLUG — a
 *     type mismatch that made the comparison false for every real supplier,
 *     so even a caller would have been told "not owned" for everything;
 *   - checked only Supplier → (application, tenant) — never that the tenant
 *     is actually linked to the application (hop 2 of the chain).
 *
 * Now every hop is verified against the platform's own rows, starting from
 * the AUTHENTICATED application slug (from the API key) and the AUTHENTICATED
 * tenant (x-tenant-id, already link-checked by the gateway — re-checked here
 * so this module is safe to call on its own):
 *   1. application: the slug resolves to an existing, active application
 *      (→ its UUID);
 *   2. tenant: that tenant has an ACTIVE link to that application UUID;
 *   3. supplier: the supplier row's application_id equals that UUID, its
 *      tenant_id equals that tenant, and it is active.
 * Any failed hop yields null ("not yours") — callers answer 403/404 without
 * saying which hop failed.
 *
 * DB-free by construction (repositories are injected, like TenantRegistry),
 * so the simulation's in-memory database double reuses it verbatim.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUPPLIER_REF_LENGTH = 255;

export interface SupplierRecordForScope {
  id: string;
  applicationId: string;
  tenantId: string;
  slug: string;
  status: string;
}

export interface SupplierScopeApplicationRepo {
  findBySlug(slug: string): Promise<{ id: string; slug: string; status?: string | null } | undefined>;
}

export interface SupplierScopeLinkRepo {
  isLinked(tenantId: string, applicationId: string): Promise<boolean>;
}

export interface SupplierScopeSupplierRepo<S extends SupplierRecordForScope = SupplierRecordForScope> {
  findById(id: string): Promise<S | undefined>;
  findByApplicationAndSlug(applicationId: string, tenantId: string, slug: string): Promise<S | undefined>;
  findByApplicationAndTenant(applicationId: string, tenantId: string): Promise<S[]>;
}

export interface SupplierScopeInput {
  /** The authenticated application's slug (AuthService.authenticate → appId). Never a request-body value. */
  appSlug: string;
  /** The authenticated tenant (verified x-tenant-id). Never a request-body value. */
  tenantId: string;
}

export class SupplierScope<S extends SupplierRecordForScope = SupplierRecordForScope> {
  constructor(
    private readonly applicationRepo: SupplierScopeApplicationRepo,
    private readonly linkRepo: SupplierScopeLinkRepo,
    private readonly supplierRepo: SupplierScopeSupplierRepo<S>,
  ) {}

  /** Hops 1-2. Returns the application UUID when (appSlug, tenantId) is a real, active, linked pair. */
  async resolveTenantApplication(input: SupplierScopeInput): Promise<string | null> {
    if (!input.appSlug || !input.tenantId) return null;
    const application = await this.applicationRepo.findBySlug(input.appSlug);
    if (!application) return null;
    if (application.status && application.status !== 'active') return null;
    const linked = await this.linkRepo.isLinked(input.tenantId, application.id);
    return linked ? application.id : null;
  }

  /**
   * Hops 1-3. `supplierRef` is the supplier's id (UUID) or its slug within
   * the tenant. Returns the supplier only if the whole chain holds.
   */
  async resolveOwnedSupplier(input: SupplierScopeInput & { supplierRef: string }): Promise<S | null> {
    const ref = typeof input.supplierRef === 'string' ? input.supplierRef.trim() : '';
    if (!ref || ref.length > MAX_SUPPLIER_REF_LENGTH) return null;
    const applicationUuid = await this.resolveTenantApplication(input);
    if (!applicationUuid) return null;

    const supplier = UUID_RE.test(ref)
      ? await this.supplierRepo.findById(ref)
      : await this.supplierRepo.findByApplicationAndSlug(applicationUuid, input.tenantId, ref);
    if (!supplier) return null;
    // Compared against the application's UUID (supplier.application_id is a
    // UUID FK), never against the slug — the F3.8 type mismatch.
    if (supplier.applicationId !== applicationUuid) return null;
    if (supplier.tenantId !== input.tenantId) return null;
    if (supplier.status !== 'active') return null;
    return supplier;
  }

  /** Boolean form of resolveOwnedSupplier. */
  async verifySupplierOwnership(input: SupplierScopeInput & { supplierId: string }): Promise<boolean> {
    return (await this.resolveOwnedSupplier({ ...input, supplierRef: input.supplierId })) !== null;
  }

  /** The suppliers the authenticated (application, tenant) owns; [] when the pair itself is not valid. */
  async listOwnedSuppliers(input: SupplierScopeInput): Promise<S[]> {
    const applicationUuid = await this.resolveTenantApplication(input);
    if (!applicationUuid) return [];
    const rows = await this.supplierRepo.findByApplicationAndTenant(applicationUuid, input.tenantId);
    // Defense in depth: never trust the query alone.
    return rows.filter((s) => s.applicationId === applicationUuid && s.tenantId === input.tenantId);
  }
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
