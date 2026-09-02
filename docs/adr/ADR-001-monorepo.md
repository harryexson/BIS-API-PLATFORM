# ADR-001: Monorepo with npm Workspaces

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

The platform consists of multiple services, shared packages, and client applications that need to share TypeScript types, utility functions, and business logic. We needed to decide how to organize these components across repositories.

### Options Considered

1. **Polyrepo** — Each service/package in its own Git repository
2. **Monorepo with npm Workspaces** — All packages in one repository, managed by npm's native workspace feature
3. **Monorepo with Turborepo** — npm workspaces + Turborepo for caching and pipeline orchestration
4. **Monorepo with Nx** — Full-featured monorepo tooling with dependency graph, generators, and affected-project detection

---

## Decision

**Monorepo with npm Workspaces** (native, no additional tooling initially).

---

## Rationale

### Against Polyrepo
- Type sharing across services requires publishing packages to a registry (npm, GitHub Packages) on every change, creating a painful inner loop during development.
- Cross-service refactoring (e.g., renaming a field on `TransactionEvent`) requires coordinated PRs across multiple repositories.
- `@company/schemas` changes that affect both `services/api-gateway` and `providers/payments/*` would be impossible to review atomically.

### For npm Workspaces over Turborepo/Nx
- **Zero additional dependencies**: npm workspaces are built into npm 7+. No Turborepo or Nx packages to maintain, upgrade, or learn.
- **Sufficient for current scale**: At 2 services, 1 app, 8 packages, and 13 provider adapters, the overhead of Turborepo's caching and pipeline configuration is not justified.
- **Upgrade path preserved**: If build times become a bottleneck, Turborepo can be added to an existing npm workspaces monorepo without restructuring.

### Workspace Structure
```
apps/*        → deployable frontend applications
services/*    → deployable backend services
packages/*    → internal shared libraries (never deployed independently)
providers/*   → provider adapter implementations (consumed by packages/providers)
```

---

## Consequences

**Positive**
- Single `npm install` installs all workspace dependencies
- `@company/*` packages are locally symlinked — no publish step during development
- TypeScript path aliases in root `tsconfig.json` resolve directly to source files
- Atomic commits that span multiple packages/services
- Single CI pipeline for the entire platform

**Negative**
- A single broken package can block `npm install` for all workspaces
- `node_modules` at the root grows large (all dependencies hoisted)
- Developers must understand workspace scoping (`npm run dev --workspace=services/api-gateway`)
- No incremental build cache — a change to `packages/schemas` triggers full rebuilds across all consumers

**Mitigation**
- Package boundaries enforced via `package.json` dependencies (a package cannot import from a package it doesn't declare as a dependency)
- Root `tsconfig.json` paths ensure IDE resolution matches runtime resolution
- Turborepo to be evaluated when CI build time exceeds 10 minutes

---

## Workspace Dependency Rules (Enforced)

```
@company/schemas     → (no internal deps)
@company/shared      → (no internal deps)
@company/config      → @company/schemas
@company/logger      → @company/config
@company/http-client → @company/logger, @company/config
@company/database    → @company/schemas, @company/logger
@company/resilience  → @company/database, @company/logger
@company/events      → @company/schemas
@company/providers   → @company/schemas, @company/http-client, @company/resilience
@company/routing     → @company/providers, @company/schemas

services/api-gateway    → all @company/* packages
services/webhook-service → @company/database, @company/logger, @company/schemas
services/worker          → @company/database, @company/logger, @company/providers
apps/admin-console       → @company/schemas, @company/shared  ← no server-side packages
```

**Rule**: `apps/admin-console` must NEVER import from server-side packages. It receives data only via HTTP.
