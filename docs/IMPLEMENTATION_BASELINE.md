# BIS API Platform — Implementation Baseline

**Generated:** 2026-09-08
**Commit at audit time:** `c779ece` (+ baseline test fixes in this pass)
**Method:** Direct inspection of the current repository plus execution of the
real build/lint/type-check/test pipeline. Prior reports in this repo
(`PRODUCTION_READINESS_REPORT.md`, `FINAL_CERTIFICATION_REPORT.md`,
`SECURITY_AUDIT_REPORT.md`, `DISASTER_RECOVERY.md`) were treated as leads,
not facts — every claim below was re-verified against the running code.

This document is Phase 0 of the master implementation plan: a factual
snapshot of what exists today, before any further phase begins.

---

## 1. Repository Shape

Monorepo, npm workspaces (`apps/*`, `services/*`, `packages/*`).

```
apps/
  admin-console/          React + Vite admin UI (auth, provider mgmt, observability, request playground)
services/
  api-gateway/             Express HTTP entrypoint — auth, tenant resolution, routing, webhooks, SSE
  worker/                  Long-running process hosting the WorkerManager + job processors
packages/
  shared/                  Cross-cutting utilities
  schemas/                 Zod/TS types shared across the platform (TransactionEvent, MessageRequest, ...)
  database/                Drizzle ORM schema + repositories + Neon Postgres connection
  providers/                Provider adapters (messaging + payments) + ProviderRegistry
  routing/                 RoutingEngine, conversation resolver, keyword engine
  events/                  EventBus (in-proc + Redis-backed history/pubsub)
  events-sdk/              Typed client for consuming platform events
  workers/                 WorkerManager, job queue abstraction, KVStore (Redis + in-memory), job processors
  api-client/              Typed client SDK for calling the gateway
  observability/           Structured logging, metrics, tracing helpers
  loadtest/                Standalone load-test runner (CLI)
  simulation/              In-memory end-to-end simulation harness + "audit" test suites
docs/
  openapi.yaml, DEVELOPER_GUIDE.md, adr/, architecture/, operations/
```

Root-level reports (pre-existing, **stale relative to the latest commits** —
see §7): `PRODUCTION_READINESS_REPORT.md`, `FINAL_CERTIFICATION_REPORT.md`,
`SECURITY_AUDIT_REPORT.md`, `DISASTER_RECOVERY.md`.

---

## 2. What Exists and Works Today

### API Gateway (`services/api-gateway`)
- Express app (`app.ts`, ~1100 lines) exposing `/v1/api/gateway/*` (messaging,
  payment, provider), `/v1/api/webhooks/:provider`, `/api/dashboard/*` (admin,
  SSE stream, logs, metrics), `/health`, `/ready`.
- Auth (`auth.ts`): DB-backed API key authentication
  (`ApplicationRegistry.authenticateApplication`), admin-key middleware for
  dashboard routes, rate limiting via `rate-limiter-flexible` —
  Redis-backed (`RateLimiterRedis` with an in-memory `insuranceLimiter`
  fallback) when `REDIS_URL` is set, falling back to `RateLimiterMemory`
  otherwise. `/ready` reports which backend is active.
- Tenant context: `resolveTenantContext` middleware validates `x-tenant-id`
  against `TenantRegistry.assertTenantAccess`; the authenticated application's
  slug is the source of truth for `appId` (not client-supplied body fields).
- Webhook ingress: HMAC-SHA256 signature verification (fail-closed if
  `WEBHOOK_HMAC_SECRET` unset), gateway-level dedup on `providerEventId`,
  event persisted + emitted to the bus, then fanned out to
  `payment_webhook` / `provider_webhook` / inbound-message queues.
- Security headers (HSTS, X-Frame-Options, X-XSS-Protection, Referrer-Policy,
  Permissions-Policy), CORS restricted via `CORS_ORIGINS`, body size capped.

### Provider Registry & Routing (`packages/providers`, `packages/routing`)
- `ProviderRegistry` holds messaging + payment provider definitions
  (capabilities, countries, environments, health status); DB-backed via
  `packages/database/src/repositories/providers.ts` and
  `provider-configs.ts` (encrypted secrets, AES-256-GCM).
- `RoutingEngine` does capability-aware selection (channel, country,
  provider health, priority) with failover across a provider list.
- Conversation resolver + keyword engine (`keywords.ts`) implement
  YES/NO/HELP/STOP/START/UNSTOP/JOIN/PRAY/CHECK-IN style inbound handling.

### Messaging & Payment Provider Adapters (`packages/providers/src/adapters`)
| Adapter | File | Status |
|---|---|---|
| SignalHouse | `messaging/signalhouse.ts` | **Simulated** — fabricates `messageId`, always `status: QUEUED`/`delivered: true`, no HTTP call |
| Infobip | `messaging/infobip.ts` | **Simulated** — same pattern |
| Generic SMS | `messaging/sms.ts` | **Simulated** |
| Email | `messaging/email.ts` | **Simulated** |
| FutureSMS | `messaging/futuresms.ts` | **Simulated**, explicitly a placeholder/example provider |
| Example (messaging) | `messaging/example.ts` | **Simulated**, reference implementation only |
| Stripe | `payments/stripe.ts` | **Simulated** (idempotency logic is real; no live Stripe SDK/HTTP call) |
| NMI, Flutterwave, PawaPay, PayChangu, Airwallex | `payments/*.ts` | **Simulated** |
| Example (payments) | `payments/example.ts` | **Simulated**, reference implementation only |

**No adapters exist yet for Africa's Talking or Trembi** — no files, no env
vars in `.env.example`. These are net-new work, not remediation.

All "simulated" adapters share the same shape: `verifyAvailability()` +
`simulateLatency()`, a fabricated provider-format response, and a
`TransactionEvent` built from that fabrication. This is the single largest
gap against the "real production requirement" in the master plan — see §6.

### Queues, Workers, Outbox (`packages/workers`)
- `WorkerManager` runs a poll loop per job type with configurable
  concurrency, lease/heartbeat semantics, and a dead-letter path.
- Transactional outbox exists: `payment_webhook` / `provider_webhook`
  processors write the domain event **and** an outbox row inside
  `runInTransaction`, so a DB failure fails the whole write atomically (job
  retries, no partial state). `outboxPoller.ts` claims + publishes pending
  outbox rows and has a `rescueStuck()` sweep for events stuck mid-flight.
- Idempotency: Redis-backed `setNx` on webhook/job keys via `KVStore`
  (`store.redis.ts`, with an in-memory fallback for tests).
- Job types: `messageDelivery`, `paymentWebhook`, `providerWebhook`,
  `inboundMessage`, `keywordResponseDelivery`, `receiptPipeline`,
  `eventProcessing`, `outboxPoller`, `reconciliation`, `retryProcessing`,
  `providerHealth`.

### Database (`packages/database`)
- Drizzle ORM against Neon Postgres. Schema covers applications, API keys,
  tenants, tenant-application links, providers, provider configs/health,
  transactions, events, outbox events, idempotency records, suppliers,
  conversations, audit logs, users/roles/permissions.
- `events.app_id` and `audit_logs.*` queries are scoped by `appId`/`tenantId`
  at the repository layer (cross-tenant leak fix from the latest commit).
- `events.app_id` is still `text`, not a foreign key to `applications.id` —
  no DB-level referential integrity (tracked gap, §4).

### Observability
- Structured logger with request/trace/tenant/app context
  (`packages/observability`), `/health` and `/ready` endpoints,
  Server-Sent-Events dashboard stream (admin-gated).
- `/ready` checks real DB connectivity (`checkDatabaseHealth`) and reports
  the active rate-limiter backend; it returns 503 when DB is unreachable.
  It does not yet check the job-queue/worker-store backend independently
  of the rate limiter's Redis connection (tracked gap, §4).

### Admin Console (`apps/admin-console`)
React/Vite app with: login gate (admin-key based), provider registry view,
provider management (enable/disable/priority/health), observability panel,
audit logs, live topology, request playground. Functional and builds clean.

### Testing
- Unit/component tests colocated with source (`*.test.ts`).
- `packages/simulation` is a genuine in-memory end-to-end harness that spins
  up the real gateway + worker stack with only the DB layer mocked, and
  drives 5 "audit" suites: donation system, messaging/conversation,
  security/tenant-isolation, resilience/failure, application certification.
  These are living regression tests that intentionally assert secure/correct
  behavior — see §7 for their current pass rate.
- One true integration suite requiring a live Postgres connection
  (`conversations.integration.test.ts`, gated by `describe.skipIf(!hasDb)`),
  now joined by `load.integration.test.ts` (moved/gated in this pass — see §7).

---

## 3. Environment Variables (from `.env.example`)

| Category | Vars |
|---|---|
| Database | `DATABASE_URL` |
| Auth/Secrets | `PLATFORM_ADMIN_KEY`, `WEBHOOK_HMAC_SECRET`, `SECRET_ENCRYPTION_KEY`, `ADMIN_API_TOKEN` |
| Deployment | `DEPLOYMENT_ID`, `NODE_ENV`, `PORT` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `NMI_GATEWAY_ID`, `NMI_API_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_PUBLIC_KEY`, `PAWAPAY_API_KEY`, `PAYCHANGU_API_KEY`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` |
| Messaging | `SIGNALHOUSE_API_KEY`, `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `FUTURESMS_API_KEY`, `FUTURESMS_BASE_URL` |
| Other providers | `GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY` |
| CORS/Rate limiting | `CORS_ORIGINS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `REDIS_URL` (optional) |
| Logging/Workers | `LOG_LEVEL`, `WORKER_CONCURRENCY`, `RECONCILIATION_INTERVAL_MS`, `IDEMPOTENCY_TTL_HOURS` |

**Not yet present:** `AFRICASTALKING_API_KEY`, `AFRICASTALKING_USERNAME`,
`TREMBI_API_KEY` (providers don't exist yet).

Startup does **not** currently validate required configuration for
production (e.g. "production + SignalHouse enabled → key required" from the
master plan's Phase 26) — it fails at request time via `verifyAvailability()`
checks inside each simulated adapter, not at boot. Tracked gap.

---

## 4. Known Gaps (Confirmed by Code Reading, Not Assumed)

These are carried forward from `SECURITY_AUDIT_REPORT.md` /
`PRODUCTION_READINESS_REPORT.md` and re-verified as still open:

1. **Real provider adapters** — all messaging + payment adapters are
   simulated (§2). This is the largest gap in the whole plan.
2. **No Africa's Talking / Trembi adapters** — not started.
3. **`/ready` has no independent queue/worker-store health check** — it
   checks DB connectivity and reports the rate-limiter backend (Redis vs.
   in-memory), but doesn't separately probe the job queue's `KVStore`
   backend. *(Correction: an earlier draft of this document, written from
   the stale `SECURITY_AUDIT_REPORT.md`, claimed gateway rate limiting was
   unwired and `/ready` did no dependency checks at all. Re-reading
   `services/api-gateway/src/auth.ts` and `app.ts` directly shows both are
   already implemented — `auth.ts` uses `rate-limiter-flexible` with
   `RateLimiterRedis` + in-memory fallback, and `/ready` calls
   `checkDatabaseHealth()` and returns 503 when the DB is unreachable.)*
4. **`events.app_id` has no FK constraint** — referential integrity gap.
5. ~~No API-key scope enforcement~~ — **closed 2026-09-08.**
   `ApplicationRegistry.authenticateApplication` now surfaces the matched
   key's `scopes`; the gateway's `mw.apiKey(requiredScope)` middleware
   factory rejects with 403 when a key has scopes configured and the
   requested capability isn't among them. A key with no scopes configured
   (`null`, the default for every key issued before this existed) remains
   unrestricted — scoping is opt-in per key, not a breaking change. Wired
   onto all 5 gateway routes: `payments:send`, `messaging:send`,
   `other:send`, `transactions:read`, `providers:read`.
6. ~~No default API-key expiry~~ — **closed 2026-09-08.** `createApplication`
   and `rotateApplicationKey` now set `expiresAt` via
   `API_KEY_DEFAULT_EXPIRY_DAYS` (default 365 days; 0 disables it).
7. ~~No circuit breaker~~ — **closed 2026-09-08.** `ProviderRegistry` now
   tracks a per-provider CLOSED/OPEN/HALF_OPEN state
   (`isCircuitAvailable`/`isProviderAvailable`, driven by `recordTraffic`),
   configurable via `CIRCUIT_BREAKER_FAILURE_THRESHOLD` /
   `CIRCUIT_BREAKER_COOLDOWN_MS`, and wired into every routing decision
   point (`RoutingEngine.routePayment`/`routeMessage`/`routeOther`,
   including manual overrides and conversation continuity) plus
   `findByCategoryAndCapabilities`. Manually setting a provider back online
   resets its circuit.
8. **No startup configuration validation** — misconfiguration (e.g. a
   provider enabled in production with no API key configured) surfaces at
   request time via each adapter's `verifyAvailability()`, not at boot.
9. **No A2P/10DLC compliance model** — no brand/campaign/consent-status
   schema; STOP/START/JOIN exist at the keyword-handler level but there's no
   `MessagingProfile`-style registration record.
10. **No payment reconciliation/settlement model** beyond a `reconciliation`
    job stub — no connected-account onboarding flow for merchant-owned
    payment accounts.
11. **npm audit**: `qs` (via `express`) has two moderate DoS advisories
    (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g) with no non-breaking fix
    available in the express 4.x line at time of audit — remediating fully
    requires an express major-version bump, out of scope for this pass.
    Everything else flagged by `npm audit` (vite, vitest, esbuild,
    drizzle-kit) is dev/build tooling, not shipped to production.

## 5. What Is Documented Elsewhere (Not Re-Litigated Here)

- `DISASTER_RECOVERY.md` — RPO/RTO, backup/restore procedures. Not
  re-verified in this pass; out of scope for Phase 0/1.
- `docs/openapi.yaml` — API contract documentation, exists and is
  reasonably current for the implemented routes.

## 6. Priority Read for Subsequent Phases

In order of what most directly blocks the master plan's stated
non-negotiables (real integrations, no fabricated delivery status, tenant
safety):

1. Real messaging adapters (SignalHouse, Infobip; then Africa's Talking,
   Trembi) — needs live credentials to fully certify, but the HTTP
   integration + error normalization + contract tests can be built now
   against each provider's public API documentation.
2. ~~Circuit breaker around provider failover~~ — done, see §4 item 7.
3. ~~API-key scope enforcement + default expiry~~ — done, see §4 items 5-6.
4. `/ready` queue/worker-store health check (DB + rate-limiter already covered).
5. A2P/10DLC `MessagingProfile` model.
6. Payment reconciliation / connected-account model.

## 7. Relationship to Prior Reports

`PRODUCTION_READINESS_REPORT.md` (Aug 26) and `FINAL_CERTIFICATION_REPORT.md`
(Aug 28) predate commits `d99b82a` and `c779ece` (Aug 31), which claim to
remediate the CRITICAL findings those reports listed (cross-tenant IDOR,
transactional outbox, webhook fail-closed HMAC, worker crash recovery). This
audit did not re-run the archived simulation suites from those reports
verbatim; instead it ran the **current** `packages/simulation` suite as it
exists on this branch today — see `docs/BASELINE_TEST_REPORT.md` for actual
results. Those two root-level reports should be treated as historical, not
current status, until superseded.
