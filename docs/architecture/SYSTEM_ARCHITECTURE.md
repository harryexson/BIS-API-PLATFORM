# System Architecture

## Overview

The **company-api-platform** is a multi-tenant API orchestration and routing platform that acts as a unified integration layer between internal client applications and third-party payment, messaging, and service providers. It abstracts provider complexity, enforces routing policies, handles failures, and provides a centralized operational surface.

---

## System Context

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT APPLICATIONS                       │
│   ReachChurch │ Afribook │ HaulPro │ STAYSCAPE │ EventHub       │
│   Ride-ly     │ Food     │ Future Apps                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS + X-API-Key
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API GATEWAY SERVICE                       │
│   Auth │ Rate Limiting │ Validation │ Request ID │ Logging      │
└──────────┬───────────────────────────────────────┬──────────────┘
           │                                       │
           ▼                                       ▼
┌─────────────────────┐             ┌──────────────────────────────┐
│ ORCHESTRATION       │             │ WEBHOOK SERVICE               │
│ & ROUTING ENGINE    │             │ Receive │ Verify │ Persist   │
│                     │             │ Deduplicate │ Update TX      │
│ RoutingEngine       │             └──────────────────────────────┘
│ CircuitBreaker      │
│ ProviderRegistry    │
└──────────┬──────────┘
           │
┌──────────┴─────────────────────────────────────────────────────┐
│                      PROVIDER ADAPTERS                          │
│                                                                 │
│  PAYMENT              MESSAGING             OTHER               │
│  ─────────────        ─────────────────     ─────────────────  │
│  Stripe               SignalHouse            Maps API           │
│  NMI                  Infobip                Identity API       │
│  Flutterwave          Future SMS             AI (Gemini)        │
│  PawaPay              Email SMTP                                │
│  PayChangu                                                      │
│  Airwallex                                                      │
└──────────┬─────────────────────────────────────────────────────┘
           │
┌──────────▼──────────┐
│  DATABASE (Neon     │
│  PostgreSQL)        │
│                     │
│  transactions       │
│  webhook_events     │
│  idempotency_keys   │
│  provider_health    │
│  circuit_breaker    │
│  api_keys           │
│  applications       │
└─────────────────────┘
```

---

## Component Inventory

| Component | Type | Technology | Responsibility |
|-----------|------|-----------|----------------|
| `services/api-gateway` | Service | Express + TypeScript | Request entry, auth, routing dispatch |
| `services/webhook-service` | Service | Express + TypeScript | Provider webhook reception + processing |
| `services/worker` | Service | Node.js + TypeScript | TX reconciliation, background jobs |
| `apps/admin-console` | Application | React + Vite | Operational dashboard |
| `packages/routing` | Library | TypeScript | Routing rules and fallback engine |
| `packages/providers` | Library | TypeScript | Provider registry and base adapter |
| `packages/database` | Library | Prisma + PostgreSQL | Data access layer |
| `packages/resilience` | Library | TypeScript | Circuit breaker state machine |
| `packages/events` | Library | TypeScript | SSE event bus |
| `packages/logger` | Library | TypeScript | Structured JSON logging |
| `packages/config` | Library | Zod + TypeScript | Environment validation |
| `packages/http-client` | Library | Axios + TypeScript | HTTP with retry/backoff |

---

## Request Lifecycle

### Payment Request (Happy Path)

```
1. App sends POST /api/gateway/payment with X-API-Key
2. Auth middleware validates API key against `api_keys` table
3. Rate limiter checks request count for this key (sliding window)
4. Zod validator checks request body schema
5. Request ID assigned (UUID v4), attached to logs
6. RoutingEngine.routePayment() evaluates:
   a. Manual override? → use it
   b. Currency/method rules → select primary provider
   c. Provider online? → proceed, else failover
   d. Circuit breaker OPEN? → failover immediately
7. Idempotency check: key exists in DB? → return cached response
8. Transaction inserted to DB with status: pending
9. Provider adapter called (real API)
10. DB transaction updated: status: success, provider_tx_id
11. TransactionEvent emitted to EventBus (→ SSE clients)
12. Response returned to client
```

### Payment Request (Failure Path)

```
7b. Provider returns retriable error (500, timeout)
    → Retry with exponential backoff (max 3 attempts)
7c. All retries exhausted
    → Circuit breaker increments failure count
    → If threshold reached: circuit opens
    → RoutingEngine selects next available provider
    → Process continues from step 8 with new provider
7d. All providers exhausted
    → Transaction marked failed in DB
    → 503 returned to client (no stack trace in production)
```

---

## Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Runtime | Node.js 20 LTS | Stability, npm ecosystem |
| Language | TypeScript 5.x | Type safety across monorepo |
| API Framework | Express 4.x | Mature, well-understood, broad middleware ecosystem |
| Database | Neon PostgreSQL | Serverless, branching, auto-scaling, Railway-compatible |
| ORM | Prisma | Type-safe queries, migration management, connection pooling |
| Frontend | React 18 + Vite | Fast HMR, ESM-native, TypeScript-first |
| Monorepo | npm workspaces | Zero-config local package linking |
| Containerization | Docker | Consistent environments across dev/staging/production |
| CI/CD | GitHub Actions | Tight GitHub integration, free for public repos |
| Hosting (API) | Railway | Simple Docker deployment, environment management |
| Hosting (Console) | Vercel | Optimal for SPA with edge CDN |

---

## Scalability Considerations

- **Stateless gateway**: The API gateway holds no session state. All state is in the database. Multiple instances can run behind a load balancer.
- **Connection pooling**: Prisma with `connection_limit` set per container to prevent overwhelming Neon's connection limits.
- **Circuit breaker state**: Persisted in the database, not in-memory, so state survives restarts and is shared across instances.
- **Worker**: A separate, single-instance service handles reconciliation jobs to avoid distributed locking complexity at this stage.

---

## Deployment Topology

```
[Internet]
    │
    ├── api.company.com ──────▶ Railway (api-gateway container)
    ├── webhooks.company.com ──▶ Railway (webhook-service container)
    └── console.company.com ───▶ Vercel (admin-console SPA)
                                     │
                          All ────── Neon PostgreSQL (shared DB)
```
