import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SupplierScope, type SupplierRecordForScope } from './supplier-scope';

/**
 * Phase 7 (gap register F3.8): the Application → Tenant → Supplier chain,
 * hop by hop. The old verifySupplierOwnership() compared
 * supplier.applicationId (a UUID) against the gateway's appId (a SLUG), so it
 * could never return true; it also never checked hop 2 (tenant ↔ application
 * link). End-to-end HTTP coverage is in
 * packages/simulation/src/tenant-isolation.scenarios.ts.
 */

const APP_UUID = randomUUID();
const OTHER_APP_UUID = randomUUID();

function world() {
  const apps = [
    { id: APP_UUID, slug: 'stayscape', status: 'active' },
    { id: OTHER_APP_UUID, slug: 'afribook', status: 'active' },
    { id: randomUUID(), slug: 'suspended-app', status: 'suspended' },
  ];
  const links = [
    { tenantId: 'tenant-a', applicationId: APP_UUID, status: 'active' },
    { tenantId: 'tenant-b', applicationId: APP_UUID, status: 'active' },
    { tenantId: 'tenant-revoked', applicationId: APP_UUID, status: 'revoked' },
    { tenantId: 'tenant-x', applicationId: OTHER_APP_UUID, status: 'active' },
  ];
  const mk = (applicationId: string, tenantId: string, slug: string, status = 'active'): SupplierRecordForScope => ({
    id: randomUUID(), applicationId, tenantId, slug, status,
  });
  const suppliers = [
    mk(APP_UUID, 'tenant-a', 'host-a'),
    mk(APP_UUID, 'tenant-b', 'host-b'),
    mk(OTHER_APP_UUID, 'tenant-x', 'vendor-x'),
    mk(APP_UUID, 'tenant-a', 'host-a-disabled', 'suspended'),
    mk(APP_UUID, 'tenant-revoked', 'host-revoked'),
  ];
  const scope = new SupplierScope(
    { findBySlug: async (slug) => apps.find((a) => a.slug === slug) },
    { isLinked: async (t, a) => links.some((l) => l.tenantId === t && l.applicationId === a && l.status === 'active') },
    {
      findById: async (id) => suppliers.find((s) => s.id === id),
      findByApplicationAndSlug: async (a, t, slug) => suppliers.find((s) => s.applicationId === a && s.tenantId === t && s.slug === slug),
      findByApplicationAndTenant: async (a, t) => suppliers.filter((s) => s.applicationId === a && s.tenantId === t),
    },
  );
  const [hostA, hostB, vendorX, disabled, revokedTenantHost] = suppliers;
  return { scope, hostA, hostB, vendorX, disabled, revokedTenantHost };
}

describe('SupplierScope — Application → Tenant → Supplier ownership chain', () => {
  it('accepts the owner, addressed by the application SLUG (the F3.8 slug-vs-UUID mismatch is gone), by supplier id or slug', async () => {
    const { scope, hostA } = world();
    expect(await scope.verifySupplierOwnership({ appSlug: 'stayscape', tenantId: 'tenant-a', supplierId: hostA.id })).toBe(true);
    expect((await scope.resolveOwnedSupplier({ appSlug: 'stayscape', tenantId: 'tenant-a', supplierRef: 'host-a' }))?.id).toBe(hostA.id);
  });

  it('hop 3: another tenant of the SAME application cannot claim the supplier (by id or by slug)', async () => {
    const { scope, hostA } = world();
    expect(await scope.verifySupplierOwnership({ appSlug: 'stayscape', tenantId: 'tenant-b', supplierId: hostA.id })).toBe(false);
    expect(await scope.resolveOwnedSupplier({ appSlug: 'stayscape', tenantId: 'tenant-b', supplierRef: 'host-a' })).toBeNull();
  });

  it('hop 3: another application cannot claim the supplier, even with a tenant id that matches', async () => {
    const { scope, hostA, vendorX } = world();
    expect(await scope.verifySupplierOwnership({ appSlug: 'afribook', tenantId: 'tenant-a', supplierId: hostA.id })).toBe(false);
    expect(await scope.verifySupplierOwnership({ appSlug: 'stayscape', tenantId: 'tenant-a', supplierId: vendorX.id })).toBe(false);
  });

  it('hop 2: a tenant not (or no longer) linked to the application owns nothing — even a supplier row naming it', async () => {
    const { scope, revokedTenantHost, vendorX } = world();
    expect(await scope.verifySupplierOwnership({ appSlug: 'stayscape', tenantId: 'tenant-revoked', supplierId: revokedTenantHost.id })).toBe(false);
    // tenant-x is linked to afribook, not stayscape
    expect(await scope.verifySupplierOwnership({ appSlug: 'stayscape', tenantId: 'tenant-x', supplierId: vendorX.id })).toBe(false);
    expect(await scope.listOwnedSuppliers({ appSlug: 'stayscape', tenantId: 'tenant-revoked' })).toEqual([]);
  });

  it('hop 1: an unknown or non-active application owns nothing; passing the UUID instead of the slug does not work either', async () => {
    const { scope, hostA } = world();
    expect(await scope.verifySupplierOwnership({ appSlug: 'nope', tenantId: 'tenant-a', supplierId: hostA.id })).toBe(false);
    expect(await scope.resolveTenantApplication({ appSlug: 'suspended-app', tenantId: 'tenant-a' })).toBeNull();
    expect(await scope.verifySupplierOwnership({ appSlug: APP_UUID, tenantId: 'tenant-a', supplierId: hostA.id })).toBe(false);
  });

  it('a non-active supplier is not usable; empty/oversized refs are rejected', async () => {
    const { scope, disabled } = world();
    expect(await scope.verifySupplierOwnership({ appSlug: 'stayscape', tenantId: 'tenant-a', supplierId: disabled.id })).toBe(false);
    expect(await scope.resolveOwnedSupplier({ appSlug: 'stayscape', tenantId: 'tenant-a', supplierRef: '' })).toBeNull();
    expect(await scope.resolveOwnedSupplier({ appSlug: 'stayscape', tenantId: 'tenant-a', supplierRef: 'x'.repeat(300) })).toBeNull();
  });

  it("listOwnedSuppliers returns only the authenticated tenant's suppliers", async () => {
    const { scope, hostA, disabled } = world();
    const ids = (await scope.listOwnedSuppliers({ appSlug: 'stayscape', tenantId: 'tenant-a' })).map((s) => s.id).sort();
    expect(ids).toEqual([hostA.id, disabled.id].sort());
  });
});
