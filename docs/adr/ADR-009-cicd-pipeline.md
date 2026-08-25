# ADR-009: CI/CD Pipeline

**Status**: Accepted  
**Date**: 2026-08-25  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

The platform requires a robust CI/CD pipeline that enforces code quality, security, and safe deployments. Every pull request must pass comprehensive checks before merge, and production deployments must require successful validation. Database migrations must be controlled to prevent data loss or corruption.

### Requirements

1. Every PR must run: lint, typecheck, unit tests, integration tests, build, security checks
2. Production deployment must require successful CI checks
3. Database migrations must be controlled (no auto-destruction)
4. Rollback procedures must be documented and available
5. Production database resources must never be automatically destroyed

---

## Decision

**GitHub Actions with parallel CI gates and controlled production deployment pipeline.**

---

## Rationale

### CI Pipeline Architecture

**Parallel gate model**: All checks run in parallel after a shared `install` job. This provides fast feedback (worst case = slowest gate) while ensuring all validations pass before merge.

| Gate | Purpose | Tool |
|------|---------|------|
| Lint | Code style and quality | ESLint + typescript-eslint |
| Type Check | Type safety | TypeScript strict mode |
| Unit Tests | Logic correctness | Vitest |
| Integration Tests | Component integration | Vitest (separate config) |
| Build | Compilation verification | TypeScript + Vite |
| Security | Dependency vulnerabilities | npm audit |
| Migration Check | Schema drift detection | drizzle-kit check |

**Final gate**: The `ci-gate` job requires all gates to pass. This is the required check for branch protection.

### Deployment Pipeline

**Controlled deployment model**: Production deployments only occur after:
1. All CI gates pass on the PR
2. PR merges to `main`
3. `production` environment approval (manual)
4. Migration validation passes

**Safety controls**:
- `drizzle-kit migrate` only (never `push` or `force`)
- Manual approval required via GitHub environments
- Rollback available via workflow dispatch
- No automated `DROP`, `DELETE`, or `TRUNCATE` operations

### Database Migration Strategy

**Forward-migration-only approach**:
- Schema changes generate Drizzle migrations via `drizzle-kit generate`
- CI validates schema matches code via `drizzle-kit check`
- Production applies migrations via `drizzle-kit migrate`
- Rollback creates reverse migrations (never destructive)
- Emergency rollback uses Neon PITR (point-in-time recovery)

### Tool Selection

**ESLint over TSLint**: TSLint is deprecated; ESLint with typescript-eslint is the standard.

**Vitest for both unit and integration**: Already in use; separate config files allow different timeouts and patterns.

**GitHub Actions over alternatives**:
- Native GitHub integration (no external service needed)
- Sufficient for monorepo with npm workspaces
- Free for public repos, reasonable for private
- Environment protection rules for production

---

## Consequences

**Positive**
- All PRs receive comprehensive quality feedback before merge
- Production deployments are controlled and auditable
- Database migrations are validated before application
- Rollback procedures are documented and available
- Security vulnerabilities are caught in CI
- Fast feedback via parallel gate execution

**Negative**
- CI pipeline takes longer than the previous simple pipeline
- Requires maintaining ESLint configuration
- Integration tests need a test database (or mocking)
- GitHub environment approval adds deployment friction (intentional)

**Mitigation**
- Parallel gates minimize wall-clock time
- ESLint config is minimal and focused on critical rules
- Integration tests can use mock databases when needed
- Deployment friction is a safety feature, not a bug

---

## Implementation Details

### Files Created/Modified

```
.github/workflows/ci.yml        — PR validation pipeline
.github/workflows/deploy.yml    — Production deployment pipeline
eslint.config.js                — ESLint configuration
vitest.config.integration.ts    — Integration test config
docs/operations/ROLLBACK.md     — Rollback procedures
docs/operations/DEPLOYMENT.md   — Updated deployment guide
package.json                    — Added lint and test:integration scripts
```

### Required GitHub Configuration

**Secrets**:
- `PRODUCTION_DATABASE_URL` — Neon PostgreSQL connection string
- `RAILWAY_TOKEN` — Railway deployment token
- `VERCEL_TOKEN` — Vercel deployment token
- `TEST_DATABASE_URL` — Test database URL

**Environments**:
- `production` — Requires manual approval, restricted to `main` branch

**Branch Protection**:
- Require status checks: `ci-gate`
- Require branches to be up to date
- Require reviews before merge
