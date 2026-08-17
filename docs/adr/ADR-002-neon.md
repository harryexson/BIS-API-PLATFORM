# ADR-002: Neon PostgreSQL as the Database

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

The platform requires a relational database for:
- Persistent transaction records (immutable audit trail)
- Idempotency key storage with TTL
- Webhook event deduplication
- Circuit breaker state (must survive process restarts)
- Provider health history
- API key management (future)

We considered several database options with the following requirements:
- PostgreSQL-compatible (standard SQL, JSON support, strong consistency)
- Works well with Railway (our deployment target for services)
- Works well with Prisma ORM
- Supports connection pooling (Node.js creates many short-lived connections)
- Low operational overhead for a small team
- Reasonable cost at startup scale

---

## Options Considered

### 1. Railway PostgreSQL (managed addon)
- **Pros**: One-click provisioning within Railway dashboard, same billing
- **Cons**: No serverless scaling, no branching, fixed instance size, backups are basic

### 2. Supabase
- **Pros**: Managed PostgreSQL, good dashboard, realtime features, generous free tier
- **Cons**: Built-in realtime/auth features we don't use add complexity, less control over connection pooling

### 3. PlanetScale (MySQL)
- **Pros**: Excellent branching, serverless scaling
- **Cons**: MySQL-only (not PostgreSQL), Prisma schema drift issues with PlanetScale's no-foreign-keys constraint, would limit SQL features

### 4. Neon (Serverless PostgreSQL)
- **Pros**: True PostgreSQL 16, serverless auto-scaling, database branching (dev/staging/prod branches), built-in connection pooler (PgBouncer-compatible), free tier generous, works with Prisma, Railway-compatible via connection string
- **Cons**: Cold starts on the free tier (first query after inactivity takes ~500ms), vendor lock-in on branching feature

### 5. Self-hosted PostgreSQL on Railway
- **Pros**: Full control, no vendor lock-in
- **Cons**: We own backups, upgrades, replication — high operational overhead for a small team

---

## Decision

**Neon PostgreSQL**

---

## Rationale

### Branching is a first-class feature for this workflow
- `main` branch = production data
- `dev` branch = development, automatically branched from main, isolated
- Preview branches for testing migrations before applying to production
- This eliminates the "test against prod-like data" vs "test against stale fixtures" dilemma

### Serverless fits the usage profile
The platform will have bursty traffic patterns (event-driven, time-of-day peaks). Neon scales compute to zero between requests on the free tier, and auto-scales on paid tiers. We're not paying for idle compute.

### Built-in connection pooling
Node.js creates many database connections (each request can open one). Neon's built-in PgBouncer connection pooler handles multiplexing without requiring us to run a separate pgBouncer instance.

### Full PostgreSQL compatibility
All standard Prisma features work: foreign keys, enums, JSON columns, array columns, `ON CONFLICT DO UPDATE` (used for idempotency), triggers (for audit timestamps).

### Cold start mitigation
Cold start only affects the free tier. On paid tiers, Neon keeps compute warm. For production, we'll use a paid plan. For local development, we use a local PostgreSQL container via `docker-compose`.

---

## Connection Strategy

```
Development:  LOCAL PostgreSQL via docker-compose (never Neon)
Staging:      Neon "staging" branch
Production:   Neon "main" branch (paid plan, no cold starts)
CI:           Neon "ci" branch, reset on each test run via Prisma migrate reset
```

### Environment Variables

```env
# packages/database
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://user:pass@host/db?sslmode=require&pgbouncer=false
```

The `DATABASE_URL_UNPOOLED` is required for Prisma migrations (which cannot run through PgBouncer due to advisory locks).

---

## Consequences

**Positive**
- Zero ops: no PostgreSQL instances to manage, upgrade, or back up
- Branching enables safe migration testing
- Free tier sufficient for development and early production
- Prisma works out of the box

**Negative**
- Neon vendor dependency — migration to another provider requires only a connection string change (since it's standard PostgreSQL)
- Cold start risk on free tier (mitigated: production uses paid plan)
- Cannot use PostgreSQL extensions not supported by Neon (e.g., PostGIS — not needed here)

---

## Migration Policy

1. Migrations are written by Prisma (`prisma migrate dev`)
2. Applied to `dev` branch, reviewed, then applied to `staging`, then `production`
3. All migrations are forward-only (no destructive rollbacks; use new migrations to fix mistakes)
4. Migration files committed to version control alongside the schema change PR
