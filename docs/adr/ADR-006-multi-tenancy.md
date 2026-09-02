# ADR-006: Multi-Tenancy Model

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

The platform serves multiple client applications (tenants):
- ReachChurch, Afribook, HaulPro, STAYSCAPE, EventHub, Ride-ly, Food, Future Apps

Each application is owned and operated by the same organization but may have different:
- Rate limit requirements (HaulPro processes more payments than ReachChurch)
- Provider preferences (ReachChurch may require Malawian providers only)
- Permission scopes (a test app should not be able to use live payment providers)
- Audit isolation (transactions from one app should not be visible to another app's dashboard)

The question is: what multi-tenancy model provides the right level of isolation?

---

## Multi-Tenancy Models

### 1. Silo Model (Database per tenant)
Each application gets its own database. Full data isolation.

### 2. Bridge Model (Schema per tenant)
Single database, separate PostgreSQL schema per tenant.

### 3. Pool Model (selected)
Single database, single schema. Tenant identified by `application_id` column on every table.

---

## Decision

**Pool Model (shared database, application_id row-level isolation).**

---

## Rationale

### Against Silo
- 8+ databases to manage, back up, and migrate for 8 applications owned by the same organization
- Cross-tenant analytics (aggregate metrics across all apps) requires cross-database queries
- Operational overhead far exceeds the isolation benefit when all tenants are trusted (same org)

### Against Bridge (Schema per tenant)
- Prisma's multi-tenant schema support requires significant custom tooling
- Schema migrations must be applied to all tenant schemas simultaneously
- Still requires cross-schema queries for aggregate analytics

### For Pool Model
- All applications belong to the same organization — not untrusted external tenants
- Row-level isolation via `application_id` is sufficient for the trust model
- Cross-application metrics trivially queryable (`SELECT * FROM transactions WHERE created_at > NOW() - INTERVAL '24 hours'`)
- Single migration applies once, affects all tenants
- Future: PostgreSQL Row Level Security (RLS) can enforce query-time isolation if needed

---

## Tenant Isolation Enforcement

### At the API Layer
Every request is authenticated against an API key → `application_id`.
Every gateway controller passes `application_id` into `RoutingEngine` calls.
`application_id` is written to every `transactions` row.

### At the Dashboard Layer
The admin console currently shows all applications (owner-level view).
Future: per-application dashboard views filtered by `application_id`.

### At the Database Layer
All queries in `packages/database` that return application-specific data must include `WHERE application_id = $1`.

```typescript
// ✅ Correct
const txs = await db.transaction.findMany({
  where: { applicationId: req.applicationId }
});

// ❌ Wrong — returns all tenants' data
const txs = await db.transaction.findMany({});
```

---

## Tenant Configuration Model

```typescript
interface Application {
  id: string;
  name: string;
  slug: string;
  
  // Rate limits
  requestsPerMinute: number;    // default: 100
  
  // Provider restrictions
  allowedProviders?: string[];  // null = all providers allowed
  defaultCurrency?: string;     // 'MWK' for Malawi-focused apps
  
  // Environment
  environment: 'test' | 'live'; // live keys vs test keys
}
```

---

## Future: External Tenants

If the platform is extended to serve external customers (not just internal apps), the pool model will be upgraded with:

1. **PostgreSQL Row Level Security** — database-enforced tenant isolation regardless of application code
2. **Tenant-specific connection strings** — each tenant gets their own Neon branch
3. **Data residency** — route tenant data to geographically appropriate database

This upgrade path is preserved by always including `application_id` on every table from day one.

---

## Consequences

**Positive**
- Simplest possible implementation for trusted multi-app architecture
- Easy aggregate analytics across all applications
- Single migration path for all applications
- No operational overhead from managing multiple databases

**Negative**
- A bug that omits `WHERE application_id = $1` could expose cross-tenant data (mitigated by code review, TypeScript types, and future RLS)
- Not suitable for untrusted external tenants without additional isolation (not current requirement)
