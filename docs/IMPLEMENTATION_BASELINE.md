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

> **2026-09-08 addendum — critical finding, since fixed:** ten repository
> files in `packages/database/src/repositories/` combined multi-field
> Drizzle query filters with the JS `&&` operator instead of `and()`,
> which silently drops every condition but the last. This affected the
> actual gateway-level tenant authorization check
> (`TenantRegistry.assertTenantAccess` → `tenant-application-links.ts`
> `isLinked`), among others. See
> `docs/IMPLEMENTATION_CHANGELOG.md` ("CRITICAL: `&&`-Chained Drizzle
> Conditions...") for the full list, the fix, and the regression guard
> added (`packages/database/src/where-clause-and.test.ts`). Flagging here
> because it directly contradicts this document's earlier characterization
> (§2) of tenant isolation as enforced — the *code path* was correctly
> wired, but the *query* it called down to wasn't actually filtering on
> the fields it appeared to.

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
  (capabilities, countries, environments, health status, secrets) — **as
  an in-memory singleton** (a synchronous constructor, shared by every
  `packages/simulation` test — see §4 item 21 for why it stays that way)
  — **whose secrets are now also durably persisted, as of 2026-09-17,
  by the gateway layer, not by this package itself.** `providerRepository`
  and `provider-configs.ts`'s `providerConfigRepository` (encrypted
  secrets, AES-256-GCM via the existing `encryptSecret`/`decryptSecret`)
  were exported from `packages/database` but never imported anywhere
  (confirmed by a full-repo search, 2026-09-15) until this pass wired
  them up from `services/api-gateway` — see §4 item 21 for the full
  design (and the `providers` table's own missing-seed prerequisite this
  surfaced and fixed along the way). `providerHealthRepository` is used
  by the worker's `provider_health` job the same way it always was — a
  durable health-check history keyed by provider slug, unrelated to
  secrets. Non-secret management state (routing rules, priority, health
  counters) still lives only in `ProviderRegistry`'s in-memory `Map`s and
  is lost on restart — that remains out of scope; only secrets durability
  was the documented gap this closed.
- `RoutingEngine` does capability-aware selection (channel, country,
  provider health, priority) with failover across a provider list.
- Conversation resolver + keyword engine (`keywords.ts`) implement
  YES/NO/HELP/STOP/START/UNSTOP/JOIN/PRAY/CHECK-IN style inbound handling.

### Messaging & Payment Provider Adapters (`packages/providers/src/adapters`)
| Adapter | File | Status |
|---|---|---|
| SignalHouse | `messaging/signalhouse.ts` | **Simulated** — fabricates `messageId`, always `status: QUEUED`/`delivered: true`, no HTTP call |
| Infobip | `messaging/infobip.ts` | **Real HTTP** (2026-09-08) — falls back to simulated when credentials unset |
| Africa's Talking | `messaging/africastalking.ts` | **Real HTTP** (2026-09-08) — falls back to simulated when credentials unset |
| Sinch | `messaging/sinch.ts` | **Real HTTP** (2026-09-09) — falls back to simulated when credentials unset |
| Vibes | `messaging/vibes.ts` | **Real HTTP** (2026-09-09) — **lower confidence**: submit path and response schema inferred, not directly observed; see the adapter's class comment. Falls back to simulated when credentials unset |
| ~~Generic SMS~~ | ~~`messaging/sms.ts`~~ | **Removed 2026-09-15** — dead code: never imported by `registry.ts` or exported from the package's `index.ts`, so it was permanently unreachable; its `.env.example` gap the earlier audit found was this file's, and it's gone with it |
| Email | `messaging/email.ts` | **Simulated** |
| FutureSMS | `messaging/futuresms.ts` | **Simulated**, explicitly a placeholder/example provider |
| Example (messaging) | `messaging/example.ts` | **Simulated**, reference implementation only |
| Stripe | `payments/stripe.ts` | **Real HTTP** (2026-09-14) — PaymentIntents API; falls back to simulated when no API key **or** no `PaymentRequest.paymentToken` (this gateway never collects raw card data). Corrects an earlier version of this file that called a real endpoint with the wrong body encoding (JSON instead of form-urlencoded) and would have failed on every live call |
| NMI | `payments/nmi.ts` | **Real HTTP** (2026-09-14) — Direct Post/Gateway API; same paymentToken-gated fallback. Previously fully simulated with no real-HTTP path at all |
| Flutterwave | `payments/flutterwave.ts` | **Real HTTP** (2026-09-14) — v3 tokenized-charges API; same paymentToken-gated fallback (also requires a customer email, read from `payload.metadata.email`). Previously fully simulated with no real-HTTP path at all |
| PawaPay | `payments/pawapay.ts` | **Real HTTP** (2026-09-15) — v2 Merchant API; no card token needed (mobile-money, phone-authorized), but gated on `payload.metadata.pawapayProvider` (an operator+country code this platform can't safely derive from a phone number) — falls back to simulated without it. A synchronous `ACCEPTED` maps to this platform's `unknown` status, not a fabricated success — PawaPay's deposit flow is async and only a callback/status-check (not built) knows the real outcome |
| PayChangu | `payments/paychangu.ts` | **Real HTTP** (2026-09-15) — Mobile Money API; same operator-code gating pattern as PawaPay (`payload.metadata.paychanguOperatorRefId`). **Lower confidence on the error envelope specifically** — its success shape was directly confirmed, its non-2xx error shape was inferred from the same pattern, not directly observed |
| Airwallex | `payments/airwallex.ts` | **Real HTTP** (2026-09-15) — PaymentIntents API, a 3-call flow (login for a cached Bearer token, create, confirm); same `paymentToken`-gated fallback as Stripe, plus a required `payload.metadata.airwallexCustomerId`. No 3D-Secure/`next_action` relay built — a `REQUIRES_CUSTOMER_ACTION` result reports as `unknown`, honestly, but nothing resolves it |
| Trembi | *(no file)* | **Not a payment provider** — investigated 2026-09-15 (see §4 item 1a): trembi.com is a sales/marketing automation platform (leads, email/SMS/WhatsApp campaigns) with its own "Messaging API," and itself uses a third party (ElemiTech) for its own payment processing. No payments API exists to build an adapter against. Flagging this rather than leaving it as unstarted work, so a future pass doesn't retry the same dead end |
| Example (payments) | `payments/example.ts` | **Simulated**, reference implementation only |

**No adapter exists yet for Trembi** — no file, no env vars in
`.env.example`. This is net-new work, not remediation.

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
  conversations, audit logs, users/roles/permissions, user sessions, user
  verification tokens (email verification / password reset).
- `users`/`roles`/`permissions` are now real and in production use
  (2026-09-09, customer account signup/login — see §4 item 14 and the
  changelog) — previously schema-only with zero call sites anywhere in the
  codebase.
- `plans`/`subscriptions` (added 2026-09-09, §4 item 16) — platform
  subscription billing for the businesses that hold an application.
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
audit logs, live topology, request playground, and (added 2026-09-09,
Phase C) a **Customers** tab — customer list, per-customer detail
(users/notes/support tickets), note-taking, and ticket create/comment/
status workflows against the new `/api/dashboard/customers*` and
`/api/dashboard/tickets*` routes. Functional and builds clean; verified
in a real headless browser this pass (not just typecheck), via mocked API
responses since this environment cannot reach the live database (same
constraint noted throughout this document).
**Phase D (2026-09-09) verified all 4 tabs function correctly** — a real
headless-browser regression pass (mocked backend, same constraint as
above) plus a permanent automated suite: `apps/admin-console/tests/
smoke.spec.ts` (`@playwright/test`, run via `npm run test:e2e` in that
workspace), 6 tests, stable across 3 runs. Found and fixed one genuine
bug in the process — see the changelog for detail.
~~Deliberately still no router library~~ — **closed, 2026-09-15**: the 4
tabs now route through `react-router-dom` (`BrowserRouter` in `main.tsx`,
`useLocation`/`useNavigate` in `App.tsx`) with real, deep-linkable,
bookmarkable URLs — `/` (Operations), `/providers` (Provider Management),
`/customers` (Customers), `/observability` (Observability) — instead of
an in-memory `useState<Tab>`. Back/forward navigation and hard-refresh on
a non-root path both work correctly (verified live, not just by code
review — see the changelog). `vercel.json` (new) adds the SPA rewrite
(`/(.*)` → `/index.html`) the production Vercel deploy needs so a direct
load or refresh on `/providers` etc. doesn't 404 — Vite's own dev server
already does this by default, which is why it wasn't visible locally
before. `tests/smoke.spec.ts` was updated to `waitForURL()` after each
tab click (the route change and its re-render are no longer synchronous
with the click, unlike the old `setState` tabs) — see the changelog for
the specific race this fixed. The root `tsc --noEmit` does **not**
typecheck this app (`tsconfig.json`'s `include` covers `packages/**` and
`services/**` only) — use `apps/admin-console`'s own `npm run type-check`.

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
| Customer account auth (added 2026-09-09) | `SESSION_TTL_HOURS`, `EMAIL_VERIFICATION_TTL_HOURS`, `PASSWORD_RESET_TTL_HOURS`, `MAX_FAILED_LOGIN_ATTEMPTS`, `ACCOUNT_LOCKOUT_MINUTES` (all optional — sensible defaults in `auth-registry.ts`) |
| Subscription billing (added 2026-09-09) | `STRIPE_BILLING_WEBHOOK_SECRET` (reuses `STRIPE_SECRET_KEY`, below, for the API calls themselves) |
| Deployment | `DEPLOYMENT_ID`, `NODE_ENV`, `PORT` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `NMI_GATEWAY_ID`, `NMI_API_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_PUBLIC_KEY`, `PAWAPAY_API_KEY`, `PAYCHANGU_API_KEY`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY` |
| Messaging | `SIGNALHOUSE_API_KEY`, `INFOBIP_API_KEY`, `INFOBIP_BASE_URL`, `FUTURESMS_API_KEY`, `FUTURESMS_BASE_URL`, `AFRICASTALKING_API_KEY`, `AFRICASTALKING_USERNAME`, `SINCH_API_TOKEN`, `SINCH_SERVICE_PLAN_ID`, `SINCH_REGION`, `VIBES_USERNAME`, `VIBES_PASSWORD` |
| Other providers | `GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY` |
| CORS/Rate limiting | `CORS_ORIGINS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, `REDIS_URL` (optional) |
| Logging/Workers | `LOG_LEVEL`, `WORKER_CONCURRENCY`, `RECONCILIATION_INTERVAL_MS`, `IDEMPOTENCY_TTL_HOURS` |

**Now present (added 2026-09-08):** `AFRICASTALKING_API_KEY`,
`AFRICASTALKING_USERNAME`. **Now present (added 2026-09-09):**
`SINCH_API_TOKEN`, `SINCH_SERVICE_PLAN_ID`, `SINCH_REGION`,
`VIBES_USERNAME`, `VIBES_PASSWORD`. **Still not present:**
`TREMBI_API_KEY` (provider doesn't exist yet).

Startup does **not** currently validate required configuration for
production (e.g. "production + SignalHouse enabled → key required" from the
master plan's Phase 26) — it fails at request time via `verifyAvailability()`
checks inside each simulated adapter, not at boot. Tracked gap.

---

## 4. Known Gaps (Confirmed by Code Reading, Not Assumed)

These are carried forward from `SECURITY_AUDIT_REPORT.md` /
`PRODUCTION_READINESS_REPORT.md` and re-verified as still open:

1. **Real provider adapters** — messaging: Infobip, Africa's Talking,
   Sinch, and Vibes are real HTTP integrations (2026-09-08/09); payments:
   **all six** documented payment providers (Stripe, NMI, Flutterwave,
   PawaPay, PayChangu, Airwallex) are now real HTTP integrations
   (2026-09-14/15, verified via WebSearch against current public docs —
   see §6 item 1 and the changelog; Vibes and PayChangu's error envelope
   at materially lower confidence than the rest — see each adapter's
   class comment). Email (messaging) closed 2026-09-17 — real send via
   Resend (`@company/shared`'s existing `sendTransactionalEmail`, the same
   integration §4 item 15 built for account-lifecycle email), reused
   rather than duplicated. SignalHouse/FutureSMS remain, and will stay,
   simulated — both reconfirmed via WebSearch, 2026-09-17, as not real,
   findable vendors; there is no real API to verify an integration
   against, so building one would mean guessing a contract, which the
   master plan prohibits. The card-based payment adapters (Stripe, NMI,
   Flutterwave, Airwallex) share one honest, structural limitation, not a
   per-provider gap: this gateway's `PaymentRequest` never collects raw
   card data (by design — PCI scope), so a real charge additionally
   requires a pre-tokenized `paymentToken` the caller obtained
   client-side (e.g. via Stripe.js); without one, even a
   fully-credentialed adapter has nothing to charge and falls back to
   simulated rather than fabricating a charge — see §4 item 1a below for
   what that gap actually requires to close. The mobile-money adapters
   (PawaPay, PayChangu) don't need a card token but do need an
   operator/country code this platform can't safely derive from a phone
   number, gated the same way via `payload.metadata`. **Trembi is not a
   payment provider** (see the adapter table above and §4 item 1a) — no
   adapter was built, and none should be; this is investigated and closed,
   not outstanding work.
1a. ~~**No client-side card tokenization flow**~~ — **closed, 2026-09-15.**
    `apps/admin-console`'s Request Playground (`RequestPlayground.tsx`) now
    mounts real Stripe Elements when the "card" payment rail is selected
    and `VITE_STRIPE_PUBLISHABLE_KEY` is configured (documented in the
    new `.env.example`) — `stripe.js` (`https://js.stripe.com/v3/`, loaded
    directly from Stripe's own domain per their fraud-detection/PCI
    requirements) is injected **dynamically** on demand, not as a static
    `<script>` tag, so the console still works with zero console errors
    when the key isn't set. `handleSubmit` calls
    `stripe.createPaymentMethod()` to obtain a real `paymentToken` before
    dispatching, which the gateway then passes straight through to
    whichever card adapter (Stripe/NMI/Flutterwave/Airwallex) is selected
    or auto-routed to. Without a key configured, the UI says so plainly
    and the request still dispatches with no token — same honest
    simulated-fallback behavior as before, just now reachable end-to-end
    when a real key is present. This closes the adapters' one remaining
    structural gap: they had nothing real to charge before this. (Still
    only wired into the internal admin console's playground, not a
    customer-facing checkout page — `apps/web` remains marketing-only —
    but the playground is this platform's only page that collects payment
    input at all, and this is what makes a real end-to-end charge provable
    without one.)
2. ~~No Africa's Talking / Trembi adapters~~ — **Africa's Talking closed
   2026-09-08, Sinch and Vibes closed 2026-09-09** (real adapters +
   registry entries, see item 1). **Trembi not attempted.**
3. ~~`/ready` has no independent queue/worker-store health check~~ —
   **closed 2026-09-08.** `/ready` now pings the Redis connection used for
   job enqueueing when `REDIS_URL` is configured (`healthy`/`unreachable`),
   and reports `unconfigured` (not a failure) when it isn't — matching the
   platform's real degraded-mode behavior of falling back to DB-only
   webhook persistence. *(Correction: an earlier draft of this document,
   written from the stale `SECURITY_AUDIT_REPORT.md`, claimed gateway rate
   limiting was unwired and `/ready` did no dependency checks at all.
   Re-reading `services/api-gateway/src/auth.ts` and `app.ts` directly
   showed both were already implemented — `auth.ts` uses
   `rate-limiter-flexible` with `RateLimiterRedis` + in-memory fallback.
   While adding the queue check, a **real, separate bug** was found and
   fixed in the DB check: `/ready` assigned `checkDatabaseHealth()`'s
   entire resolved object to a boolean-ish variable and treated any
   non-throwing result as `'healthy'`, so a `degraded`/`unhealthy` DB
   status (returned, not thrown, by that function) never actually
   surfaced — see `docs/IMPLEMENTATION_CHANGELOG.md` for the fix.)*
4. ~~**`events.app_id` has no FK constraint**~~ — **closed 2026-09-17.**
   `events.app_id` actually holds the application's *slug* (e.g.
   `'reach-church'`), not its UUID primary key — every real caller
   resolves it that way (`services/api-gateway/src/auth.ts`'s
   `authenticateApplication` sets `appId = application.slug`), so the FK
   references `applications.slug` (a unique column), not `applications.id`.
   Two sentinel values were already in real use for events with no owning
   tenant app — `'system'` (provider-level events: `provider_webhook`
   processing, the reconciliation job) and `'webhook'` (a payment webhook
   whose payload carried no `metadata.appId`) — confirmed via a full-repo
   search for every literal `appId:` value written to the `events` table.
   Rather than special-case these in application code, the migration
   (`packages/database/drizzle/0001_events_app_id_fk.sql`) seeds them as
   real `applications` rows first (idempotent, `ON CONFLICT DO NOTHING`),
   then adds the constraint — every `events.app_id` is now a genuinely
   valid reference, no exceptions. Verified live before applying: the
   `events` table was completely empty (0 rows), so there was no orphaned
   data to reconcile. Applied to the live database with explicit
   confirmation (same standing rule as every other live-DB write this
   session), and `drizzle.__drizzle_migrations` updated to match (hash
   `b62092211d3befab6e23351076eb6f4ed2e43b3e80c5c6755fb316e76841f283`) —
   verified immediately after: both sentinel rows exist, the constraint
   exists (`pg_constraint` lookup), `applications` row count is exactly
   the expected 4 real + 2 sentinel = 6. This is also the first real
   incremental migration generated against the single-baseline history
   from item 12 below — confirms that consolidation actually works for
   ongoing schema changes, not just a fresh deploy.
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
8. ~~No startup configuration validation~~ — **closed 2026-09-08** for the
   configuration that actually has teeth today (`DATABASE_URL` always;
   `WEBHOOK_HMAC_SECRET`/`SECRET_ENCRYPTION_KEY`/`PLATFORM_ADMIN_KEY` in
   production). Both `services/api-gateway` and `services/worker` now
   call `assertStartupConfig()` (`packages/shared/src/startup-config.ts`)
   before doing anything else and `process.exit(1)` with a clear,
   itemized message if invalid — verified by actually running the
   gateway entrypoint with production config missing (exit code 1, no
   attempt to bind the port). Provider-level API-key validation (e.g.
   "SignalHouse enabled in production requires SIGNALHOUSE_API_KEY") is
   **not** included: every current adapter is simulated and never reads
   its API key at all, so validating a key nothing checks would be
   hollow — this becomes meaningful once real adapters land (§4 item 1).
9. ~~STOP is logged but never enforced on outbound sends~~ — **closed
   2026-09-08.** `consent_records` table + `RoutingEngine.routeMessage`
   now blocks outbound sends to an opted-out recipient (403
   `ConsentBlockedError`), and JOIN restores it. See
   `docs/IMPLEMENTATION_CHANGELOG.md` ("Phase 39: Consent Management").
   ~~No A2P/10DLC `MessagingProfile` model~~ — **closed (registration CRUD
   only) 2026-09-08.** `messaging_profiles` table + `POST`/`GET
   /v1/api/gateway/messaging-profiles` + admin
   `PATCH /api/dashboard/messaging-profiles/:id` for compliance-status
   transitions. Explicitly **not** in scope: enforcing `complianceStatus`
   against outbound sends (an unregistered/rejected 10DLC number can still
   send today — this table is a registration record, not a gate), and any
   integration with a real carrier/registrar API to verify status
   automatically. See `docs/IMPLEMENTATION_CHANGELOG.md` ("Phase 40/41:
   A2P/10DLC Messaging Profiles").
10. ~~No payment reconciliation/settlement model~~ beyond a `reconciliation`
    job stub — **detection-and-reporting closed 2026-09-17** (see §4 item
    23). No connected-account onboarding flow for merchant-owned payment
    accounts remains genuinely out of scope — that's a distinct feature
    (multi-tenant payment ownership), not a reconciliation gap.
11. **npm audit**: `qs` (via `express`) has two moderate DoS advisories
    (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g) with no non-breaking fix
    available in the express 4.x line at time of audit — remediating fully
    requires an express major-version bump, out of scope for this pass.
    Everything else flagged by `npm audit` (vite, vitest, esbuild,
    drizzle-kit) is dev/build tooling, not shipped to production.
12. ~~Drizzle migration *files* have diverged from reality~~ — **the
    file-side problem closed 2026-09-15**, the live-database side has
    one deliberately-deferred follow-up. Original finding (2026-09-08,
    static analysis before DB access) overstated the danger: the live
    database's `tenants`, `conversations`, and `tenant_application_links`
    tables always matched the current TypeScript schema — there was
    never live data at risk. The real problem was that the migration
    *files* didn't explain how the live DB got there: `drizzle/meta/
    *.json` snapshots only existed through migration 0001 even though
    SQL files went to 0012, so `drizzle-kit generate` couldn't be
    trusted (confirmed live: it prompted to satisfy `tenants.country_
    code` by *renaming* three unrelated columns that don't exist on
    that table — accepting it would have generated a wrong, destructive
    migration).

    **Fix:** consolidated the fragmented 13-file history into one
    `0000_baseline.sql` (+ matching snapshot), freshly generated from
    the current schema — the old files are preserved, not deleted, in
    `packages/database/drizzle/_archive_pre_baseline_2026-09-15/`.
    Verified against the live database before committing (not assumed):
    the live DB has exactly 30 tables — the 28 this baseline creates,
    plus two confirmed-orphaned ones (below) — and four representative
    tables (`tenants`, `applications`, `users`, `provider_configs`) were
    spot-checked column-for-column, matching exactly (only column
    *order* differed, which Postgres attaches no meaning to). A fresh
    deployment (`drizzle-kit migrate` against an empty database) now
    produces the current schema correctly — that part of the gap is
    closed. Full rationale in `packages/database/drizzle/README.md`.

    ~~Deliberately not done in this pass~~ — **also closed, 2026-09-15,
    after explicit human confirmation.** The live database's own
    `drizzle.__drizzle_migrations` bookkeeping table (14 rows, reflecting
    the old fragmented history plus some raw-SQL-applied migrations that
    never matched any committed file's hash) held a live-database write
    this pass had stopped short of making autonomously, per this
    session's standing rule against running consequential SQL against
    the live database without asking first. Once approved: its 14 rows
    replaced with a single row recording the new baseline's real
    `sha256` hash. Verified immediately after, by direct query, that no
    application data changed — row counts on `applications`, `users`,
    `transactions`, and the two orphaned tables below were identical
    before and after; only this one bookkeeping table was touched.
    `drizzle-kit migrate` run against this database now correctly sees
    "already up to date" instead of a mismatched history.

    Also confirmed still true: two tables in the live DB
    (`checkout_sessions`, `webhook_jobs`) have no corresponding schema
    file in the current codebase and no reader/writer anywhere in the
    repo (re-verified via a full-repo search) — orphaned, holding
    negligible data (1 row and 0 rows respectively), intentionally left
    alone rather than dropped (that direction can't be undone, and
    confirming they're truly dead deserves a human decision). This
    repo's `consent_records`/`messaging_profiles` tables (added
    2026-09-08/09) were applied directly to the live DB via raw SQL at
    the time, for the reasons above — now correctly represented in the
    new baseline like every other current table.
13. ~~**Gateway inbound-webhook enqueue silently no-ops without
    `REDIS_URL`**~~ — **closed, 2026-09-15.**
    `services/api-gateway/src/app.ts`'s `enqueueInboundMessage()` (and its
    `enqueuePaymentWebhook`/`enqueueProviderWebhook` siblings) used a raw
    `ioredis` client with no fallback — without Redis configured, no
    inbound message (including STOP) ever reached the worker via the real
    webhook route. Replaced with `@company/workers`'s own
    `createStore()`/`JobQueue` — the same abstraction the worker service
    itself uses (`services/worker/src/index.ts`) — which degrades to an
    ephemeral in-memory store the same way the rest of the platform
    already does when Redis is unavailable, instead of dropping the job
    outright. `GET /ready`'s `unconfigured` vs. `unreachable` distinction
    for the `queue` dependency is preserved exactly (verified live both
    ways: unset `REDIS_URL` → `unconfigured`/200; a configured-but-dead
    `REDIS_URL` → `unreachable`/503).

    **A real, previously-undetectable bug found and fixed while closing
    this**: `packages/workers/src/jobs/providerWebhook.ts` and
    `paymentWebhook.ts` both used a shared `webhook:${eventId}` idempotency
    key. The gateway enqueues one `provider_webhook` job and one
    `payment_webhook` job per inbound delivery, both carrying the *same*
    upstream event id (it's one HTTP request) — so whichever job type's
    processor claimed the key first made the *other* type fail every
    retry as a false "replay detected" and dead-letter. This bug already
    existed in the original raw-ioredis code (it built the exact same
    shared key), but could never manifest because the enqueue was a
    complete no-op in every environment tested — this fix is what finally
    made it observable. Fixed by namespacing each job type's idempotency
    key by its own type (`provider_webhook:${eventId}` /
    `payment_webhook:${eventId}`).

    The two pre-existing "documented gap" tests in
    `packages/simulation/src/messaging-conversation.simulation.test.ts`
    (plus the 7-keyword `it.each` block) now assert the real end-to-end
    path instead: a real HTTP webhook delivery, enqueued through the
    gateway's real queue, processed by a worker attached to that same
    queue (see `SimRuntime.gatewayStore`/`gatewayKeys` and
    `getGatewayQueueForTests()` in `app.ts`, exposed only for this
    harness). `CHECK IN` and `WHERE IS MY DRIVER?` now correctly reach
    `handleKeyword()` for real too, but that function still has no case
    for either — a separate, still-open, honestly-flagged gap (no
    app-specific keyword handler exists yet for either), not something
    this pass invents a fix for.

14. ~~No customer signup/login~~ — **closed 2026-09-09.** See the changelog
    ("Customer Account Auth: Signup/Login"). The transactional-email gap
    noted here originally is now closed too — see item 15.
15. ~~No transactional email integration~~ — **closed 2026-09-14.**
    `packages/shared/src/email.ts` sends real verification/password-reset
    emails via Resend's HTTP API, wired into signup,
    `/resend-verification`, and `/request-password-reset`. Fire-and-forget
    (never blocks the request it's attached to); the dev-only token echo
    in the API response is kept as a fallback. Real, remaining gap within
    it: no frontend page exists yet in this repo to land a verify-email/
    reset-password link on (`PLATFORM_APP_URL` is a placeholder for
    wherever that page eventually lives) — the email always also includes
    the raw token as plain text so it stays actionable via a
    support-assisted API call in the meantime. The `EmailProvider`
    messaging adapter (client apps' own outbound email, a different
    concern from this platform's own transactional email) remains
    simulated — unchanged, not in scope here.
16. ~~No subscription/billing model for platform customers~~ — **Phase B
    done, 2026-09-09.** `plans` + `subscriptions` tables, a real
    Stripe Customers/Subscriptions integration (`SubscriptionRegistry`,
    with the same simulated-fallback pattern as every provider adapter),
    and a correctly-signature-verified `/v1/api/billing/webhooks/stripe`
    route — see the changelog ("Subscription Billing: Plans, Stripe
    Subscriptions"). ~~**Remaining gap within it**: plan usage limits
    (`messageLimit`, `paymentVolumeLimitCents`) are stored but not
    enforced anywhere in the gateway/routing path — a `starter`-plan
    application can send unlimited messages today.~~ **Closed,
    2026-09-15**: `/v1/api/gateway/payment` and `/v1/api/gateway/messaging`
    both now call a `checkPlanLimit()` helper in `app.ts` before routing —
    it looks up the application's active subscription and plan, sums real
    durable usage for the current billing period (`transactions` with
    `status='success'` for payment volume, `events` with
    `category='messaging'` and `status='success'` for message count —
    both scoped to `subscription.currentPeriodStart`, not an in-memory
    counter), and returns HTTP 402 with a plain-English reason once the
    plan's limit would be exceeded. A subscription with no limit set on
    a given dimension (`null`) is left unrestricted, matching the existing
    plan model. The messaging route previously never wrote to the `events`
    table at all (a separate pre-existing gap fixed as part of this, since
    it made message-count enforcement impossible without it). See the
    changelog ("Plan Usage-Limit Enforcement") for the query shape and the
    7 simulation tests covering both dimensions.
17. ~~No CRM/support back office~~ — **Phase C done, 2026-09-09.**
    `customer_notes`/`support_tickets`/`ticket_comments` tables, a
    `CrmRegistry`, `requireAdmin`-gated `/api/dashboard/customers*` and
    `/api/dashboard/tickets*` routes, and a new admin-console Customers
    tab — see the changelog ("Developer CRM / Support Back Office").
    Admin auth is still the single shared-secret token
    (no per-admin identity, so ticket/note authorship is a free-text
    field the person types in, not tied to an account). ~~The admin
    console itself (Phase D) still has no router and remains 4 in-memory
    tabs~~ — **closed 2026-09-15**, see §2's Admin Console section.
18. ~~A single failed async route handler could crash the entire
    gateway~~ — **closed 2026-09-14.** Found live while running the app
    for a preview, not by static review: opening the admin console's
    Customers tab triggered an unhandled promise rejection that killed
    the whole Node process, not just that request — every tenant, every
    route, down at once. Express 4 doesn't route a rejected promise from
    an async handler to `app.use((err, ...))` unless the handler calls
    `next(err)` itself; 12 of 32 async route handlers in `app.ts` (auth,
    billing, customers, tickets, consent, messaging-profiles, webhooks)
    had neither a try/catch nor that call. Added an `asyncHandler()`
    wrapper and applied it to exactly those 12. Verified live: the same
    request that previously killed the gateway now returns a normal 500
    and every other route keeps serving right after.
19. ~~**Provider secrets configured through the admin console had zero
    real effect**~~ — **closed 2026-09-15.** Found while auditing what
    "ready to add providers" actually requires operationally, not just at
    the code level: `BaseProvider.setSecrets()` — what actually populates
    the `this.secrets.<field>` every real adapter's HTTP calls read — was
    never called anywhere outside test files. The admin console's Add/
    Delete Secret UI and `POST /api/dashboard/providers/:id/secrets`
    wrote to `ProviderRegistry`'s own `ManagementState.secrets` array,
    which nothing downstream ever consumed — entering a real API key
    through the console did *nothing*; every adapter still only ever read
    its hardcoded `process.env.<PROVIDER>_API_KEY`. Compounding it:
    `register()` auto-generated a fake random `sk_...` "secret" for every
    provider at startup that nothing used either — purely decorative, and
    would have actively broken every adapter's env-var fallback the
    moment secrets syncing went live, by shadowing it with garbage.
    Fixed:
    - `ProviderSecretMeta` gained a `field` property (`packages/schemas`)
      naming which `this.secrets.<field>` key a value populates.
    - `ProviderRegistry.addSecret()`/`deleteSecret()` now rebuild a
      `{field: value}` record from whatever's stored and call the live
      provider instance's real `setSecrets()` — takes effect on the
      adapter's very next request, no restart.
    - The fake auto-generated secret is gone; a provider starts with no
      secrets and relies on its env-var fallback until an admin adds one.
    - `BaseProvider.isConfigured()` (default `true`, i.e. harmless for
      simulation-only adapters) was added and overridden on all 10 real
      HTTP adapters, reusing each one's own existing credential-presence
      check (the same condition it already used to decide
      simulated-vs-real) — no new judgment calls invented. Exposed as
      `ProviderManagement.configured` and shown as a "Configured"/"Not
      Configured" badge in the admin console (list + detail view), plus a
      startup `console.warn` for any `'live'`-environment provider that's
      unconfigured — replacing total silence (a broken provider previously
      gave no signal anywhere until its first real request quietly fell
      back to simulated) with a signal in two places an operator would
      actually see it.
    - The admin console's Add Secret form gained a `field` selector,
      populated per-provider from a `PROVIDER_SECRET_FIELDS` map (falls
      back to free text for providers not in the map) so an admin is
      guided to the exact field name an adapter expects instead of
      guessing.
    - `docs/adr/ADR-005-provider-adapters.md`'s "Adding a New Provider"
      section was stale on several points beyond secrets entirely
      (`packages/config` doesn't exist, wrong file paths, a test-folder
      convention this repo doesn't use) — amended in place, with the
      authoritative current process moved to the new
      `docs/providers/ADDING_A_PROVIDER.md`. `docs/DEVELOPER_GUIDE.md`
      separately claimed inbound provider webhooks are authenticated by
      each provider's own native signature (Stripe's `Stripe-Signature`,
      etc.) — at the time, false: every provider's inbound webhook was
      verified against one shared, platform-wide `WEBHOOK_HMAC_SECRET`
      HMAC, not any provider's real scheme. Corrected then; a later pass
      (see this doc's "Native per-provider inbound webhook signature
      verification" entry, and `IMPLEMENTATION_CHANGELOG.md`) closed the
      gap for 5 of the 6 real payment providers — this doc and
      `DEVELOPER_GUIDE.md` §9a were both updated again at that point to
      reflect it.
    - `messaging/sms.ts` (dead code — unregistered, unexported, the
      source of a `.env.example` gap an earlier audit flagged) was
      deleted rather than fixed; it added nothing the registered
      `example.ts` template doesn't already cover.
    - **Real, remaining gap at the time, noted rather than silently
      left**: secrets (and all provider management state) still lived
      only in `ProviderRegistry`'s in-memory `Map`s — see this doc's
      corrected "Provider Registry & Routing" note above. A secret added
      through the admin console did not survive a gateway restart; only
      the env-var fallback did. **Closed 2026-09-17** — see item 21
      below.
    10 new `isConfigured()` unit tests (one per real adapter) plus a new
    Playwright regression test
    (`apps/admin-console/tests/provider-secrets.spec.ts`) cover this —
    see the changelog.
20. ~~**Inbound provider webhooks verified against one shared, generic
    HMAC — never each provider's own real signature scheme**~~ —
    **closed for 5 of 6 real payment providers, 2026-09-17.**
    `BaseProvider` gained `verifyProviderWebhookSignature(rawBody, headers)`
    (default: returns `null`, meaning "no native scheme available"),
    overridden with each provider's real, WebSearch-verified scheme in
    `stripe.ts` (`Stripe-Signature`: `t=`/`v1=`, HMAC-SHA256 of
    `${timestamp}.${rawBody}`, 300s replay window), `nmi.ts`
    (`Webhook-Signature`: `t=`/`s=`, HMAC-SHA256 of `${nonce}.${rawBody}` —
    `t` is a nonce, not a timestamp, so no replay window applies),
    `flutterwave.ts` (`verif-hash`: a static configured value, *not* a
    computed HMAC — direct constant-time comparison; one source disputes
    whether it's the raw value or its SHA-256, flagged inline since this
    environment couldn't reach flutterwave.com to confirm), `paychangu.ts`
    (`Signature`: plain HMAC-SHA256, identical shape to the platform's own
    generic scheme, just keyed by PayChangu's own secret), and
    `airwallex.ts` (`x-timestamp`/`x-signature`: HMAC-SHA256 of
    `${timestamp}${rawBody}` with no separator). `services/api-gateway/src/
    app.ts`'s `/v1/api/webhooks/:provider` route now calls the native check
    first and only falls back to the generic `WEBHOOK_HMAC_SECRET` check
    when it returns `null`; a native check returning `false` rejects the
    delivery outright and never falls through to the weaker generic check.
    **PawaPay is the deliberate exception, not an oversight**: its real
    scheme is RFC-9421 HTTP Message Signatures — asymmetric, keyed by
    PawaPay's own published public key with its own canonicalization
    rules — a materially larger, riskier undertaking with no live sandbox
    in this environment to validate against; documented in `pawapay.ts`'s
    class comment rather than guessed at. PawaPay webhooks still use the
    generic fallback. A secondary defense-in-depth interaction was found
    and fixed while wiring this up: `packages/workers/src/jobs/
    {paymentWebhook,providerWebhook}.ts` each independently re-verify a
    webhook's signature against `WEBHOOK_HMAC_SECRET` before processing
    it (a real, separate safety net against a bug in the enqueue path) —
    which would have wrongly rejected every natively-verified delivery,
    since a provider's real signature (e.g. Stripe's) isn't the platform's
    generic HMAC. Fixed by adding `verificationMethod: 'native' | 'platform'`
    to `ProviderWebhookEvent` (`packages/schemas`), set by the gateway and
    threaded through the enqueued job payload; the worker's generic
    re-check now only runs for `'platform'`-verified deliveries, trusting
    a `'native'` verification as already done (correctly) at the gateway.
    `docs/DEVELOPER_GUIDE.md` §9a and `docs/providers/ADDING_A_PROVIDER.md`
    §6 (both previously described this as entirely unimplemented) and
    `.env.example` (new `STRIPE_WEBHOOK_SECRET`, `NMI_WEBHOOK_SIGNING_KEY`,
    `FLUTTERWAVE_SECRET_HASH`, `PAYCHANGU_WEBHOOK_SECRET`,
    `AIRWALLEX_WEBHOOK_SECRET`) were updated to match. New tests: a
    `verifyProviderWebhookSignature()` suite per adapter (null when
    unconfigured, true for a correct signature, false for a tampered body
    or missing header — plus Stripe's replay-window case and PawaPay's
    always-`null` case), and `packages/workers/src/jobs/
    {paymentWebhook,providerWebhook}.test.ts` (new files) proving the
    native-verified path is trusted and the platform-verified path still
    fails closed on a bad or missing signature.
21. ~~**Provider secrets configured through the admin console lived only
    in `ProviderRegistry`'s in-memory `Map`s — never survived a
    restart**~~ — **closed 2026-09-17.** `packages/providers` stays fully
    DB-free by design (`ProviderRegistry`'s constructor is synchronous and
    the class is a process-wide singleton shared by every
    `packages/simulation` test) — it gained two new pure in-memory
    methods instead, `exportSecretsForPersistence(id)` (the current
    plaintext secrets, for a caller to encrypt and store) and
    `hydrateSecrets(id, secrets)` (restores them, never clobbering a
    secret already added this process). `services/api-gateway`, which
    already depends on both `packages/providers` and `@company/database`,
    owns the actual persistence: a new `packages/database/src/
    provider-secrets.ts` (`ensureProviderRow`, `persistProviderSecrets`,
    `loadAllProviderSecrets`) encrypts the full current secrets set with
    the existing (previously fully unused) `encryptSecret`/`decryptSecret`
    AES-256-GCM helpers and writes it to the existing (also previously
    unused) `provider_configs` table, one row per (provider, deployment
    tier — `'live'` in production, `'test'` elsewhere, not the
    provider's own admin-toggleable `'live'`/`'test'` environment field,
    to avoid secrets becoming unreachable if that changes mid-life).
    `provider_configs.provider_id` is a real FK to `providers.id`, a table
    with no seeding path anywhere in the codebase before this — confirmed
    empty on the live DB (`SELECT count(*) FROM providers` → 0) — so
    `providerRepository` gained an atomic `upsertBySlug()` (`ON CONFLICT
    DO UPDATE`, verified against the live `providers_slug_unique`
    constraint), called from the gateway's secrets-add/delete routes
    themselves (not only once at startup — an admin adding a provider's
    very first secret can't wait on a separate startup loop that may not
    have reached that provider yet) so the row is seeded exactly when
    it's first needed, idempotently. Both directions are fire-and-forget
    from the gateway's perspective: persistence failing (e.g.
    `SECRET_ENCRYPTION_KEY` unset, the normal case outside production)
    never blocks or fails the add/delete HTTP response, since the
    in-memory registry state — what every real adapter call actually
    reads — is already correct the moment `addSecret()`/`deleteSecret()`
    returns; hydration failing at startup falls back to exactly the
    env-var behavior that existed before this pass. No new migration was
    needed — both `providers` and `provider_configs` already existed on
    the live database from an earlier, never-wired pass. New tests:
    `packages/providers/src/providerRegistry.test.ts` gained coverage for
    `exportSecretsForPersistence`/`hydrateSecrets` (including the
    never-clobber guarantee); a new
    `packages/simulation/src/provider-secrets-persistence.simulation.test.ts`
    drives the real HTTP secrets routes end-to-end and decrypts what
    landed in the (mocked) `provider_configs` table to prove it round-
    trips correctly, including that a delete persists an empty set rather
    than leaving a stale one. `packages/simulation/src/db.ts`'s
    `installDatabaseMock()` was extended with `providerRepository`,
    `providerConfigRepository`, and mirrors of the three
    `provider-secrets.ts` functions (backed by new `dbState.providers`/
    `providerConfigs` arrays) — without this, every simulation test that
    boots the gateway would have hit an unmocked `undefined` the moment
    this pass wired the persistence calls into the secrets routes.
22. **New: real payment refund capability** — closed 2026-09-17. There was
    no way to initiate a refund anywhere in the real gateway before this —
    `docs/openapi.yaml` documented a `Refunds` tag with a `POST /refunds`
    route, but no such route (or any refund route at all) existed in
    `services/api-gateway/src/app.ts`. Added `BaseProvider.processRefund()`
    (default: an honest `status: 'failed'` with an explanatory error, not
    a silent no-op or a fabricated success) and real, WebSearch-verified
    implementations for Stripe (`POST /v1/refunds`), NMI (`type=refund` on
    the same `transact.php` endpoint charges use), and Flutterwave
    (`POST /v3/transactions/{id}/refund`, whose real settlement is
    async — reported as `'unknown'`, not a fabricated `'success'`). New
    `POST /v1/api/gateway/refund` route: looks up the transaction by the
    same provider-side id clients already have (not this platform's
    internal database id), enforces it's currently `'success'`, enforces
    a partial-refund amount doesn't exceed the original, and on a
    confirmed-success result transitions the transaction to `'refunded'`
    (an `'unknown'` result is left alone — the existing `charge.refunded`
    webhook handling in `packages/workers/src/jobs/paymentWebhook.ts`
    already resolves it once the provider confirms, the same path a
    dashboard-initiated refund already used). `packages/api-client`
    gained a matching `payments.refund()` method. Tests: a
    `processRefund()` suite per adapter (Stripe/NMI/Flutterwave, plus
    PawaPay's inherited default), and a new
    `packages/simulation/src/refund.simulation.test.ts` driving the real
    end-to-end route (partial refund, over-amount rejection, double-refund
    rejection, cross-application ownership rejection).
23. **New: real payment reconciliation (detection, not silent
    auto-resolution)** — closed 2026-09-17.
    `packages/workers/src/jobs/reconciliation.ts` was, despite its name, a
    system/queue health report generator with zero payment-specific logic
    — confirmed by reading it directly. Added
    `transactionRepository.findStaleUnresolved(olderThanMs)`: transactions
    stuck in `pending`/`processing`/`unknown` past a configurable
    threshold (`RECONCILIATION_STALE_THRESHOLD_MS`, default 1 hour).
    Deliberately detection-only — auto-resolving a stuck transaction's
    outcome from internal state alone would be exactly the kind of
    fabrication this platform's master plan prohibits for a real charge;
    only the provider (its dashboard, or the webhook this platform already
    ingests) actually knows what happened. The reconciliation job now
    includes a `payments` section in its report (and audit-log entry) with
    every stale transaction's id/provider/amount; a new on-demand
    `GET /api/dashboard/reconciliation` route (admin-gated) exposes the
    same query without waiting for the next scheduled run. Tests: a new
    `packages/workers/src/jobs/reconciliation.test.ts` and
    `packages/simulation/src/reconciliation.simulation.test.ts` (stale
    pending/unknown transactions reported; recent, resolved, or
    already-refunded ones are not).
24. **New finding: outbound platform webhooks are more built than "not
    implemented" but still not reachable end-to-end** — found and
    documented (not built further) 2026-09-17, while reconciling
    `docs/openapi.yaml` and `docs/DEVELOPER_GUIDE.md` §9b against the real
    gateway. Both docs previously presented a working "register a URL,
    receive a signed `WebhookEvent` envelope" feature as current — false.
    What's actually real: `packages/events/src/webhook-delivery.ts`'s
    `WebhookDelivery` class is a genuine, working outbound POST engine
    (exponential-backoff retry, 5 attempts) — but it is never instantiated
    or called anywhere in `services/api-gateway` or `packages/workers`,
    and there is no schema, admin-console UI, or API route for a developer
    to register a callback URL in the first place, so nothing ever
    supplies it a target. It also sends no signature today (`X-Webhook-Id`/
    `X-Webhook-Attempt` headers only) despite `packages/api-client`'s
    `WebhooksResource.verify()`/`constructEvent()` already being built,
    unused, to check one. The remaining work to finish it is well-scoped:
    a `webhook_endpoints` table + admin-console CRUD, an
    `EventBus.subscribe()` listener wired to `WebhookDelivery.enqueue()`
    for the right event types, and HMAC signing added to
    `processQueue()`. Deliberately not attempted this pass (a live-database
    migration plus a new customer-facing feature, on top of everything
    else already shipped this pass) — corrected in both docs rather than
    left presented as current, and tracked here as the next well-defined
    pickup.
25. **`docs/openapi.yaml` and `docs/DEVELOPER_GUIDE.md` reconciled with the
    real gateway** — closed 2026-09-17. Both documents' own text had
    already flagged this as a known, unfinished correction (openapi.yaml's
    top-of-file note said "Payments/Refunds/Messages/Conversations/
    Providers sections still need the same pass" as Auth/Billing already
    got). Rewrote: every path from a fictional `/payments`,`/refunds`,
    `/messages/{id}`, `/conversations/{id}`, `/providers/{id}` REST-resource
    design to the real `/v1/api/gateway/{payment,refund,messaging,
    transaction/{id},providers}` routes (plus the new refund route from
    item 22); the base-URL/server convention (`/health`+`/ready` sit
    outside `/v1`, everything else is under it — previously wrong for
    both); the error envelope (flat `{error: string}`, not a nested
    `{error:{code,message,request_id}}` object with a fabricated code
    enum); the idempotency model (`x-idempotency-key`, payment-create
    only, replay-cache semantics — not a `409 idempotency_conflict` that
    never happens in the real gateway); cross-cutting headers (only
    `X-Request-Id` is a real response header — `X-Correlation-Id` is
    request-only, never echoed back, contrary to the prior claim); amounts
    (major currency unit, e.g. `49.99`, not minor-unit cents); and
    identifiers (adapter/provider-generated, no fixed `pay_`/`msg_`/`ref_`
    prefix scheme). Confirmed there is no real pagination anywhere, and no
    real `GET` read API for an individual message or a conversation
    thread. `packages/api-client` (a separate, already-accurate rewrite
    from an earlier pass) needed only the new `payments.refund()` method
    to stay in sync — everything else it already documented matched.
    Verified every schema/parameter/response `$ref` in the rewritten YAML
    resolves (a small script, not manual inspection) after the rewrite.

## 5. What Is Documented Elsewhere (Not Re-Litigated Here)

- `DISASTER_RECOVERY.md` — RPO/RTO, backup/restore procedures. Not
  re-verified in this pass; out of scope for Phase 0/1.
- `docs/openapi.yaml` — API contract documentation, exists and is
  reasonably current for the implemented routes.

## 6. Priority Read for Subsequent Phases

In order of what most directly blocks the master plan's stated
non-negotiables (real integrations, no fabricated delivery status, tenant
safety):

1. Real messaging adapters (SignalHouse, Infobip, Africa's Talking, Sinch,
   Vibes, Trembi) — needs live credentials to fully certify. **Status as of
   2026-09-08, part two**: `WebFetch` (direct page retrieval) is blocked
   for this session — `infobip.com` and, as a control,
   `developers.google.com` both failed with `EGRESS_BLOCKED`, confirming
   a blanket session-level restriction, not a per-provider issue. `WebSearch`
   is **not** blocked, though, and returns real, current search-result
   snippets (with source URLs) rather than full pages — that was enough to
   verify Infobip's and Africa's Talking's real API contracts (endpoint,
   auth header format, request/response shape, error envelope, status
   values) via several targeted queries. **Infobip** (`infobip.ts`) and
   **Africa's Talking** (net-new `africastalking.ts`, registered in
   `registry.ts`) were rewritten as real HTTP integrations on that basis —
   see `docs/IMPLEMENTATION_CHANGELOG.md` ("Real Provider Adapters:
   Infobip + Africa's Talking") for exactly which facts came from which
   search and the full list of what's still unverified (no live account
   for either). **SignalHouse remains simulated** — it's a small/niche
   provider with essentially nothing useful in search results (confirmed
   by trying), so building it "for real" would mean guessing the contract,
   which the master plan explicitly prohibits.
   **Status as of 2026-09-09**: user supplied direct documentation URLs
   for **Sinch** (`sinch.com/messaging/sms-api/send-sms`) and **Vibes**
   (`developer.vibes.com`). Both domains are also `EGRESS_BLOCKED` for
   `WebFetch` in this session (confirmed by trying), so the same
   `WebSearch`-only method was used. **Sinch** (net-new `sinch.ts`,
   registered in `registry.ts`) was built at confidence comparable to
   Infobip/Africa's Talking. **Vibes** (net-new `vibes.ts`) was built at
   materially *lower* confidence — search snippets were thinner, and the
   exact submit path/response schema are inferred from a URL pattern
   rather than directly observed; this is documented in detail in the
   adapter's own class comment and should not be removed until verified
   against a live Vibes sandbox. See `docs/IMPLEMENTATION_CHANGELOG.md`
   ("Real Provider Adapters: Sinch + Vibes") for the full breakdown.
   **Trembi not attempted** this pass. Every adapter above still needs
   either a live account/sandbox to verify against, or the provider's docs
   supplied directly (file or pasted text) for anything not yet built.
2. ~~Circuit breaker around provider failover~~ — done, see §4 item 7.
3. ~~API-key scope enforcement + default expiry~~ — done, see §4 items 5-6.
4. ~~`/ready` queue/worker-store health check~~ — done, see §4 item 3.
5. ~~STOP consent enforcement on outbound sends~~ — done, see §4 item 9.
6. ~~A2P/10DLC `MessagingProfile` registration model~~ — done (CRUD only,
   not enforcement), see §4 item 9.
7. ~~**Drizzle migration history divergence**~~ (§4 item 12) — **closed
   2026-09-15**, including the live database's own migration-bookkeeping
   reconciliation (done with explicit human approval).
8. ~~Gateway inbound-webhook enqueue path~~ (§4 item 13) — **closed
   2026-09-15**: the raw ioredis calls in
   `services/api-gateway/src/app.ts` now go through the same abstracted
   job queue (`@company/workers`) the rest of the system uses, so
   STOP/inbound messages work end-to-end without depending on Redis being
   reachable at that exact call site. Closing this also surfaced and fixed
   a real, previously-undetectable idempotency-key collision between the
   `provider_webhook` and `payment_webhook` job processors — see §4 item
   13 for detail.
9. Payment reconciliation / connected-account model.
10. ~~Customer signup/login~~ — **Phase A done, 2026-09-09** (§4 item 14).
    ~~Subscription/billing~~ — **Phase B done, 2026-09-09** (§4 item 16).
    ~~CRM/support back office~~ — **Phase C done, 2026-09-09** (§4 item 17).
    ~~Admin console verification~~ — **Phase D done, 2026-09-09** — a
    real-browser regression pass across all 4 tabs (found and fixed one
    genuine bug) plus a permanent `@playwright/test` suite
    (`apps/admin-console/tests/smoke.spec.ts`, `npm run test:e2e`). See
    the changelog for what was deliberately left out of scope (a router
    library) and why.
    All 4 phases of the original request are now done. Real gaps
    remaining, none silently dropped:
    - ~~A real transactional email integration~~ — **closed 2026-09-14**,
      see §4 item 15.
    - ~~Plan usage-limit enforcement~~ — **closed 2026-09-15**, see §4
      item 16.
    - ~~Admin console routing~~ — **closed 2026-09-15**, see §2's Admin
      Console section.
11. ~~Real payment adapters~~ — **all six done: Stripe/NMI/Flutterwave
    closed 2026-09-14, PawaPay/PayChangu/Airwallex closed 2026-09-15**
    (§4 item 1), same WebSearch-verification method as the messaging
    adapters above. **Trembi investigated and found not to be a payment
    provider** (§4 item 1, adapter table above) — nothing left to build
    here. ~~The real remaining work is §4 item 1a (client-side card
    tokenization)~~ — **closed 2026-09-15**, see §4 item 1a.
12. Landing page (`apps/web`) visual redesign — done 2026-09-14 per user
    request (larger type/icon scale, real font loading, a responsive nav
    that previously broke at phone widths). Cosmetic, not a production-
    readiness gap, but tracked here since it was done in the same pass.

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
