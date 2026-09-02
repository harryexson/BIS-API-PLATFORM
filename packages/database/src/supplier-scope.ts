import { supplierRepository } from '@company/database';

/**
 * P0: Supplier ownership verification.
 *
 * Before connecting a multi-supplier application, every sensitive operation
 * must verify the applicable ownership chain:
 *   Application → Tenant → Supplier → Resource
 *
 * This function verifies that a supplier belongs to the given application and tenant.
 */
export async function verifySupplierOwnership(
  appId: string,
  tenantId: string,
  supplierId: string,
): Promise<boolean> {
  const supplier = await supplierRepository.findById(supplierId);
  if (!supplier) return false;
  return supplier.applicationId === appId && supplier.tenantId === tenantId;
}

/**
 * Get a supplier by application, tenant, and slug.
 * Returns null if not found or ownership mismatch.
 */
export async function getOwnedSupplier(
  appId: string,
  tenantId: string,
  slug: string,
) {
  const supplier = await supplierRepository.findByApplicationAndSlug(appId, tenantId, slug);
  if (!supplier) return null;
  if (supplier.applicationId !== appId || supplier.tenantId !== tenantId) return null;
  return supplier;
}
