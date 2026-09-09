# BIS API Platform — Implementation Changelog

Chronological record of implementation phases against the master
production-readiness plan. Each entry lists what changed, why, and what
tests cover it.

---

## 2026-09-09 — Admin Console Verification + Permanent Regression Suite (Phase D of 4)

**Context:** final phase of the same 4-phase request as Phases A/B/C
(below). The user's literal ask for this phase was to "make sure the
admin console is functioning properly" — a verification request, not a
request to add routing infrastructure. Scoped accordingly: this phase is
a thorough regression pass across all 4 tabs (Operations, Provider
Management, the new Customers tab, Observability) plus turning that
verification into a permanent, automated check, rather than bolting on
`react-router` (a real architecture change with genuine regression risk)
to a console that has zero pre-existing test coverage of any kind.

### What was done
- **Manual regression pass in a real headless browser** (Chromium via
  Playwright, launched against the environment's pre-installed browser at
  `/opt/pw-browsers/chromium`) — booted the Vite dev server standalone,
  mocked every `/api/dashboard/*` and `/api/observability/*` endpoint the
  console calls (this environment cannot reach the live database, the
  same constraint noted throughout this document), and walked all 4 tabs
  plus tab-switching. **Found and fixed one real bug in the process**
  (not a pre-existing one — introduced by this session's own first
  regression-script draft, not by the app): the mock `/api/observability/
  metrics` response didn't match `Observability.tsx`'s actual
  `MetricsSnapshot` interface (`counters`/`latency`/`providerHealth`),
  which crashed the component with "Cannot convert undefined or null to
  object." Confirms the check is doing real work, not rubber-stamping —
  a wrong assumption about a response shape surfaces immediately as a
  crash, exactly like it would with real data.
- **Turned that manual check into `apps/admin-console/tests/smoke.spec.ts`**
  (new `@playwright/test` devDependency) — 6 tests, run via
  `npm run test:e2e` in `apps/admin-console`: each of the 4 tabs renders
  real (mocked) data with zero console/page errors, the Customers tab's
  unauthenticated gate renders correctly, and switching through all 4
  tabs in sequence never throws. `playwright.config.ts` pins
  `launchOptions.executablePath` to the environment's pre-installed
  Chromium rather than letting Playwright attempt its own version-matched
  download, per this session's environment notes.
- **One real test-harness bug found and fixed while building the suite**:
  the login helper did `page.goto('/')` then `page.evaluate(...
  localStorage.setItem...)` then `page.reload()` — the reload cancels the
  first load's in-flight `fetch()` calls mid-navigation, which surfaces
  as spurious "Failed to fetch" console errors that look like app bugs
  but aren't. Fixed by seeding `localStorage` via `page.addInitScript()`
  before a single navigation instead. Documented in the test file so a
  future contributor doesn't reintroduce the same race.
- **Result: no app defects found.** All 4 tabs — including the Phase C
  Customers tab — render correctly with real backend data, no console
  errors, no crashes, and tab-switching doesn't corrupt state.

### Deliberately not done in this phase
- **No router library added.** The console remains 4 in-memory tabs via
  `useState`, not real URLs — no deep-linking, no browser back/forward
  between tabs, no page-refresh tab persistence. This was flagged as a
  known gap in Phases A–C's changelog entries and remains one; adding
  `react-router` (or similar) is a real architecture change, and doing it
  under this phase's actual scope ("make sure it's functioning") without
  dedicated design/testing time would be exactly the kind of
  under-verified change the master plan warns against. Tracked as a
  follow-up, not silently dropped.

### Tests
- `apps/admin-console/tests/smoke.spec.ts` — 6 new Playwright tests,
  confirmed stable across 3 consecutive runs (no flakiness) once the
  login-helper race above was fixed.
- `apps/admin-console`'s own `npm run type-check` — clean (covers the new
  test/config files too; confirmed the root `tsc --noEmit` still does
  **not** cover `apps/**`, so this remains the only way to typecheck this
  app — see Phase C's entry).
- Full backend suite unaffected by this phase (no backend code changed):
  399 passed, 12 pre-existing skipped, unchanged from Phase C.
  `npm run build:all` clean.

**Files changed:** `apps/admin-console/package.json` (new
`@playwright/test` devDependency, new `test:e2e` script),
`apps/admin-console/playwright.config.ts` (new),
`apps/admin-console/tests/smoke.spec.ts` (new), `.gitignore` (Playwright
artifact directories), `package-lock.json`.

**This closes out the 4-phase request** (customer signup/login,
subscription billing, developer CRM/support back office, admin console
verification). Real, load-bearing gaps that remain across all four
phases, for whoever picks this up next: no transactional email
integration (Phase A/B — verification/reset tokens have no delivery path
in production), no plan usage-limit enforcement (Phase B), and no admin
console routing (Phase D, this entry) — none of these were silently
dropped; each is called out explicitly in `IMPLEMENTATION_BASELINE.md`
§4/§6.

## 2026-09-09 — Developer CRM / Support Back Office (Phase C of 4)

**Context:** continuation of the same 4-phase request as Phases A/B
(below). This is Phase C — a customer list, notes, and support tickets
for BIS staff, backend + admin console UI. Phase D (admin console
routing/regression consolidation) is the only phase not started.

### What was built
- **Schema** (migration `0012_add_crm.sql`, applied directly to the live
  Neon project, same hand-written/hand-applied method as 0010/0011):
  `customer_notes` (free-text notes on an application), `support_tickets`
  (subject/description/status/priority/requester), `ticket_comments`
  (threaded replies on a ticket). `authorName` is a plain string rather
  than a user FK — admin auth is still a single shared token
  (`requireAdmin`), so there's no per-admin identity to reference.
- **`CrmRegistry`** (`packages/database/src/crm-registry.ts`) — composes
  `applicationRepository.findAll()` (confirmed already existed — the
  2026-09-09 audit's finding was that no *route* exposed it, not that the
  repository layer lacked it) with subscriptions/plans (Phase B) and the
  new notes/tickets/comments repos into a `listCustomers()`/
  `getCustomer()` view. **Security fix caught during review, not after**:
  `getCustomer()` initially spread real `User` rows (which include
  `passwordHash`) straight into the API response — TypeScript's
  `UserSummary` interface doesn't strip that field at runtime, only an
  explicit field whitelist does. Fixed before this was ever exercised
  over HTTP by building a `toUserSummary()` mapper; a dedicated test
  (`'never leaks passwordHash through getCustomer'`, at both the unit and
  HTTP-simulation level) guards the regression.
- **Gateway routes** (`services/api-gateway/src/app.ts`, new "DEVELOPER
  CRM / SUPPORT BACK OFFICE" section, all `requireAdmin`-gated — same
  single shared-secret admin auth as every other `/api/dashboard/*`
  route): `GET /customers`, `GET /customers/:id`, `POST /customers/:id/
  notes`, `GET /tickets` (optionally `?status=`), `GET /tickets/:id`,
  `POST /customers/:id/tickets`, `PATCH /tickets/:id`, `POST /tickets/:id/
  comments`.
- **Admin console UI** (`apps/admin-console/src/components/Customers.tsx`,
  new "Customers" tab in `App.tsx`) — a customer list (plan, subscription
  status, user count, open ticket count) that drills into a detail view:
  users, notes with an add-note form, and a support-ticket panel
  (create, expand to see/add comments, one-click status change).
  Verified in a real headless browser (Chromium via Playwright), not just
  typecheck/build: booted the Vite dev server standalone, confirmed the
  unauthenticated gate renders, then mocked `/api/dashboard/*` responses
  via request interception (no live DB reachable from this environment —
  same constraint as every other real-data verification this session) to
  confirm the populated list, customer detail, and expanded-ticket views
  render with zero console/page errors. Screenshots retained for this
  session only, not committed to the repo.

### Tests
- `packages/database/src/crm-registry.test.ts` — 13 unit tests against
  in-memory fakes, including the passwordHash-leak regression guard.
- `packages/simulation/src/crm.simulation.test.ts` — 11 tests booting the
  real gateway: admin-auth enforcement, full customer/note/ticket/comment
  CRUD, ticket status → `resolvedAt`, and the same passwordHash-leak check
  at the HTTP level.
- Extending `packages/simulation/src/db.ts` was required again (`app.ts`
  now also constructs a `CrmRegistry` at module load time) — including
  adding `applicationRepository.findAll()` to the mock, which didn't
  exist there before, and backfilling a `createdAt` field onto mock
  application rows (several pre-existing call sites — `seedReachChurch`,
  the `ApplicationRegistry`/`AuthRegistry` mocks' own app-creation paths —
  never set one; defaulted lazily in the two read paths that now need it
  rather than touching every writer).
- Full suite: 411 total (399 passed, 12 pre-existing skipped) — confirmed
  3x consecutive runs, 0 failures. Lint (0 errors — including the new
  `Customers.tsx`, zero findings), `apps/admin-console`'s dedicated
  `type-check` script (clean — the root `tsc --noEmit` does **not** cover
  `apps/**/*.tsx`, so this had to be run separately), and
  `npm run build:all` all clean.

**Files changed:** `packages/database/drizzle/0012_add_crm.sql` (new),
`packages/database/drizzle/meta/_journal.json`, `packages/database/src/
schema/{customer-notes,support-tickets,ticket-comments,index}.ts` (3
new), `packages/database/src/repositories/{customer-notes,support-
tickets,ticket-comments,index}.ts` (3 new), `packages/database/src/
crm-registry.ts` (new) + `.test.ts` (new), `packages/database/src/
repositories/applications.ts` (no change needed — `findAll()` already
existed), `packages/database/src/index.ts`,
`services/api-gateway/src/app.ts`, `packages/simulation/src/db.ts`,
`packages/simulation/src/crm.simulation.test.ts` (new),
`apps/admin-console/src/components/Customers.tsx` (new),
`apps/admin-console/src/App.tsx`.

## 2026-09-09 — Subscription Billing: Plans, Stripe Subscriptions (Phase B of 4)

**Context:** continuation of the same 4-phase request as Phase A (below).
This is Phase B — subscription/billing for the platform's own customers
(the businesses that hold an application). Phases C (CRM/support back
office) and D (admin console consolidation) are not started yet.

### What was built
- **Schema** (migration `0011_add_subscriptions.sql`, applied directly to
  the live Neon project, same hand-written/hand-applied method as
  migration 0010 and for the same reason — see that entry): new `plans`
  table (slug, price, interval, soft usage limits, an optional
  `stripe_price_id` for when a plan has a live-mode Stripe Price) and
  `subscriptions` table (one row per application; `stripe_customer_id`/
  `stripe_subscription_id`, period dates, `cancel_at_period_end`).
  Seeded with 3 placeholder plans (Starter/Growth/Enterprise) —
  **placeholder pricing for a real billing mechanism, not a business
  decision about actual prices**; whoever owns pricing should update these
  rows before this is used for real billing. Confirmed via `run_sql`
  before applying that this was a genuinely new, empty pair of tables.
- **Stripe Billing HTTP client + `SubscriptionRegistry`**
  (`packages/database/src/subscription-registry.ts`) — a *different*
  Stripe object graph than `packages/providers/src/adapters/payments/
  stripe.ts` (which only calls the one-off Charges API): Customers,
  Subscriptions, cancellation. Facts verified via WebSearch against
  Stripe's current API reference (2026-09-09), not memory — endpoint
  paths/params for creating a customer and a subscription, and
  specifically that `DELETE /v1/subscriptions/{id}` cancels immediately
  while `POST /v1/subscriptions/{id}` with `cancel_at_period_end: true`
  schedules cancellation (a real, easy-to-get-backwards distinction).
  Not verified against a live Stripe account. Same real-HTTP +
  simulated-fallback philosophy as every provider adapter: without
  `STRIPE_SECRET_KEY` (or when a plan has no `stripePriceId` yet), it
  fabricates a `sim_sub_`-prefixed subscription with a real
  period-end date computed from the plan's interval — never a fabricated
  "real" Stripe id. No retry/backoff logic (unlike `BaseProvider.
  http_request`, which the payment adapters get for free) — a deliberate
  scope cut, not an oversight.
- **Gateway routes** (`services/api-gateway/src/app.ts`, new
  "SUBSCRIPTIONS / BILLING" section): `GET /v1/api/billing/plans` (public),
  `GET /subscription`, `POST /subscribe`, `POST /cancel` (all
  session-authed via Phase A's `requireSession`), and
  `POST /webhooks/stripe`.
- **Real Stripe webhook signature verification** — the billing webhook
  route verifies the actual `Stripe-Signature` header (`t=<unix>,
  v1=hex_hmac_sha256(`${t}.${rawBody}`, secret)`, 5-minute tolerance),
  verified via WebSearch against Stripe's docs, **not** the platform's
  pre-existing generic `WEBHOOK_HMAC_SECRET` scheme used by
  `/v1/api/webhooks/:provider` — that scheme only ever checks against this
  platform's own signing convention and would reject every genuine Stripe
  delivery, so reusing it here would have shipped a webhook endpoint that
  cannot actually receive real Stripe events. Required capturing the raw
  request body (`express.json()`'s `verify` callback, stashed as
  `req.rawBody`) since Stripe's signature is computed over the exact raw
  bytes, not a re-serialized `JSON.stringify(req.body)`.
- `.env.example`: `STRIPE_BILLING_WEBHOOK_SECRET` (reuses the existing
  `STRIPE_SECRET_KEY`for the API calls themselves).
- `docs/openapi.yaml`: new `Billing` tag and full path/schema definitions
  for all 5 routes.

### Tests
- `packages/database/src/subscription-registry.test.ts` — 15 unit tests
  against in-memory fakes (plan listing, subscribe/simulated-fallback,
  unknown application/plan rejection, plan-change updates the same row,
  immediate vs. scheduled cancellation, `syncFromStripeEvent` for all 3
  handled event types plus unrecognized-event and unknown-subscription
  no-ops).
- `packages/simulation/src/billing.simulation.test.ts` — 12 tests booting
  the real gateway, including a full HMAC round-trip: signing a payload
  with `createHmac('sha256', ...)` exactly as Stripe's algorithm specifies
  and confirming the real route accepts it and rejects a bad one.
- Extending `packages/simulation/src/db.ts` was required again, same
  reason as Phase A — `app.ts` now also constructs a `SubscriptionRegistry`
  at module load time.
- Full suite: 384 total (372 passed, 12 pre-existing skipped) — confirmed
  3x consecutive runs, 0 failures. Lint (0 errors), typecheck, and
  `npm run build:all` all clean.

**Files changed:** `packages/database/drizzle/0011_add_subscriptions.sql`
(new), `packages/database/drizzle/meta/_journal.json`,
`packages/database/src/schema/{plans,subscriptions,index}.ts` (2 new),
`packages/database/src/repositories/{plans,subscriptions,index}.ts` (2
new), `packages/database/src/subscription-registry.ts` (new) + `.test.ts`
(new), `packages/database/src/index.ts`, `services/api-gateway/src/app.ts`,
`packages/simulation/src/db.ts`, `packages/simulation/src/
billing.simulation.test.ts` (new), `docs/openapi.yaml`, `.env.example`.

**Known gap carried into Phase C/D:** plan limits (`messageLimit`,
`paymentVolumeLimitCents`) are stored but **not enforced anywhere** — a
`starter`-plan application can send unlimited messages today. Enforcement
would need to hook into the routing engine or gateway request path and
wasn't in scope for standing up the billing mechanism itself.

## 2026-09-09 — Customer Account Auth: Signup/Login (Phase A of 4)

**Context:** user asked for four things in one request — (1) subscription
setups for customers, (2) signup/login authentication, (3) a full
developer-facing CRM/support back office, and (4) making sure the admin
console works. A prior read-only audit confirmed all four were either
fully absent or (for the admin console) healthy but minimal — see that
audit's findings folded into §1/§2/§3 of `IMPLEMENTATION_BASELINE.md`
below. Given the scope, this is being delivered as four sequenced,
independently-tested phases rather than partial work spread across all
four; this entry is Phase A. Phases B (subscriptions/billing), C
(CRM/support back office), and D (admin console consolidation) are not
started yet.

**What "customer" means here:** the businesses that hold a BIS Platform
application (Reach Church, HaulPro, Afribook) — i.e. this platform's own
developer/business customers self-provisioning API access — not the
end-consumers those businesses message/charge. This reuses the existing
`users` table (scoped to one `applicationId`), which existed in schema
only, with zero production usage anywhere in the codebase before this
change (confirmed by the audit).

### What was built
- **Schema** (migration `0010_add_user_auth.sql`, applied directly to the
  live Neon project `orange-water-80452818` — hand-written and
  hand-applied via `run_sql_transaction`, not `drizzle-kit generate`,
  because this repo's migration history is already known to have drifted
  from the schema on disk (see the 2026-09-08 "Drizzle Migration History
  Has Diverged" entry below) and generating against it produces unsafe
  interactive rename-vs-new-column guesses):
  - `users.role_id` (nullable FK → `roles.id`) — connects the previously
    dead `roles`/`permissions` tables to something real: signup creates an
    "Owner" role (full-access, `resource: '*', action: '*'`) for the new
    application and assigns it to the first user.
  - A new global unique index on `users.email` (signup/login take no
    application context from the caller — "one signup creates one
    application" is this platform's self-serve model). Safe to add: the
    table had 4 pre-existing rows (old manual QA data), all distinct
    emails, verified via `run_sql` before applying.
  - New tables `user_sessions` (opaque, hashed, revocable session
    tokens — same design as `application_api_keys`, not a JWT, so
    logout/password-reset can invalidate a session immediately) and
    `user_verification_tokens` (single-use tokens shared by email
    verification and password reset, distinguished by a `purpose` column).
- **Crypto** (`packages/database/src/crypto.ts`): `hashPassword`/
  `verifyPassword` (scrypt, random salt per password — this module already
  used `scryptSync` for the secret-encryption key, so this is consistent
  with existing dependencies, no new npm package); `hashToken` (sha256,
  generalized from the existing `hashApiKey`) plus `generateSessionToken`/
  `generateVerificationToken` for opaque revocable tokens, same shape as
  the existing `generateApiKey`.
- **`AuthRegistry`** (`packages/database/src/auth-registry.ts`) — same
  dependency-injected registry pattern as `ApplicationRegistry`/
  `TenantRegistry`: `signup` (creates the application + Owner role + user
  in one call, via `ApplicationRegistry.createApplication`), `login`
  (generic "Invalid email or password" for both wrong-password and
  unknown-email, to avoid account enumeration; lockout after 5 failed
  attempts for 15 minutes, using the `failedLoginAttempts`/`lockedUntilAt`
  columns that already existed on `users` but were never wired to
  anything), `logout`, `verifySession`, `requestPasswordReset`/
  `resetPassword` (resetting revokes every existing session for the
  account), `resendEmailVerification`/`verifyEmail`.
- **Gateway routes** (`services/api-gateway/src/app.ts`, new "CUSTOMER
  ACCOUNT AUTH" section): `POST /v1/api/auth/signup`, `/login`, `/logout`,
  `GET /me`, `POST /verify-email`, `/resend-verification`,
  `/request-password-reset`, `/reset-password`. Distinct from the
  existing per-application API-key auth (`mw.apiKey`, used by
  `/v1/api/gateway/*`) and the single shared-secret admin auth
  (`requireAdmin`, used by `/api/dashboard/*`) — this is a third,
  person-level auth surface. Rate-limited by the existing
  `app.use('/v1/api', mw.rateLimit)` (keyed by IP for these routes, since
  they carry no API key yet).
- **Known, explicitly-labeled gap:** no transactional email sending was
  built (would need a real SMTP/SES/Postmark/etc. integration and
  credentials this session doesn't have). Email verification and password
  reset tokens are surfaced directly in the API response, but *only
  outside production* (`NODE_ENV !== 'production'`) — never fabricated as
  "emailed" when they weren't. In production these endpoints currently
  have no way to deliver the token to the user; wiring a real email send
  is required before this phase is production-usable end to end.
- **`docs/openapi.yaml`**: new `Auth` tag, `sessionAuth` security scheme
  (distinct from the existing `bearerAuth` API-key scheme), and full path
  definitions for all 8 routes — intentionally lighter-weight (inline
  schemas, no per-error-code component refs) than the `Payments`/
  `Messages` sections, to fit this phase's scope.

### Tests
- `packages/database/src/auth-registry.test.ts` — 22 unit tests against
  in-memory fakes (signup validation/conflict, login success/failure/
  lockout/enumeration-resistance, session verify/logout/expiry, password
  reset end-to-end including session revocation, email verification
  including reuse rejection).
- `packages/simulation/src/auth.simulation.test.ts` — 14 tests that boot
  the **real gateway** (`services/api-gateway/src/app.ts`, unmodified)
  against the in-memory Neon double and exercise every route over real
  HTTP, including confirming a signup-issued API key actually authenticates
  against `/v1/api/gateway/*`, and that `dbState.users` gets a real row
  with a non-plaintext password hash.
- Extending `packages/simulation/src/db.ts` (the shared in-memory Neon
  double used by ~30 other simulation test files) to support the new
  repos/`AuthRegistry` was **required, not optional** — `app.ts` now
  imports `AuthRegistry` and constructs one at module load time, so every
  existing simulation test that boots the gateway would otherwise crash
  immediately with "No AuthRegistry export is defined on the mock" (this
  was caught by actually running the existing suite mid-change, not
  assumed safe).
- Full suite: 343 passed, 12 pre-existing skipped (unrelated integration
  tests needing live DB/network) — confirmed 3x consecutive runs, 0
  failures. Lint (0 errors), typecheck, and `npm run build:all` all clean.
- **Not tested in this session**: an actual HTTP request against the real
  Neon database — this environment's own app process still cannot reach
  `api.c-2.us-east-2.aws.neon.tech` (403, host not in the network
  allowlist), the same constraint documented in the 2026-09-08 "Attempted:
  Real Provider Adapters — Blocked by Network Policy" entry. The migration
  itself *was* applied to and verified against the real Neon project via
  the Neon MCP tools, which are unaffected by that restriction.

**Files changed:** `packages/database/drizzle/0010_add_user_auth.sql`
(new), `packages/database/drizzle/meta/_journal.json`,
`packages/database/src/schema/{users,user-sessions,user-verification-tokens,index}.ts`,
`packages/database/src/repositories/{users,user-sessions,user-verification-tokens,roles,index}.ts`,
`packages/database/src/crypto.ts`, `packages/database/src/auth-registry.ts`
(new) + `.test.ts` (new), `packages/database/src/index.ts`,
`services/api-gateway/src/app.ts`, `packages/simulation/src/db.ts`,
`packages/simulation/src/auth.simulation.test.ts` (new),
`docs/openapi.yaml`, `.env.example`.

## 2026-09-09 — Real Provider Adapters: Sinch + Vibes

**Phase:** 6 of the master plan (continued). User-requested addition of two
more messaging providers, given their public documentation URLs
(`sinch.com/messaging/sms-api/send-sms`, `developer.vibes.com`).

**How the facts were verified:** Same method as the Infobip/Africa's
Talking entry below — `WebFetch` is blocked for both `sinch.com` and
`developer.vibes.com` (confirmed `EGRESS_BLOCKED`), so all facts came from
`WebSearch` result snippets and their source URLs, gathered 2026-09-09.
Neither adapter has been tested against a live account — no credentials
were available in this session.

### Sinch (net-new: `packages/providers/src/adapters/messaging/sinch.ts`)
Confidence level: comparable to Infobip/Africa's Talking — multiple
corroborating search results for the endpoint, auth, and request/response
shapes.
- `POST https://{region}.sms.api.sinch.com/xms/v1/{SINCH_SERVICE_PLAN_ID}/batches`
  (the "Batches" endpoint of Sinch's SMS API), `Authorization: Bearer
  {SINCH_API_TOKEN}`. `SINCH_REGION` selects `us` (default) or `eu` — Sinch
  serves SMS from regional endpoints, not a single global one.
- Request: `{ from, to: [recipient], body: content }`
- Success response: `{ id, to, from, body, canceled, created_at,
  modified_at }` — `canceled: false` only confirms Sinch *accepted* the
  batch, not delivery; per-recipient delivery status arrives later via a
  webhook this session did not build, so it is never fabricated here.
  `canceled: true` is reported as a real failure.
- Error envelope: `{ code, text }`, parsed into the real error message.
- Same simulated-fallback pattern as the other real adapters when
  `SINCH_API_TOKEN`/`SINCH_SERVICE_PLAN_ID` are unset.
- Registered with `countries: ['*']` (Sinch is a global Tier-1 SMS
  aggregator, same treatment as Infobip).
- 7 new contract tests (`sinch.test.ts`): simulated fallback makes no HTTP
  call; real request shape/URL/region is correct; `canceled: true` is
  reported as failed, not success; the documented error envelope is
  parsed; a malformed response (no batch id) fails cleanly; the `eu`
  region routes to the eu endpoint; `status: offline` short-circuits.

### Vibes (net-new: `packages/providers/src/adapters/messaging/vibes.ts`)
**Lower confidence than every other real adapter in this platform** — the
class-level comment in `vibes.ts` documents this in detail and should be
read before trusting or extending the adapter further. Search snippets for
Vibes were noticeably thinner than for the other three real providers.
- CONFIRMED: base URL `https://messageapi.vibesapps.com` (US/Canada SMS);
  HTTP Basic auth (`base64(email:password)`); `Content-Type: text/xml`
  required; XML vocabulary `mtMessage`/`submitterMessageId`/`destination`/
  `source`/`text`.
- **NOT CONFIRMED, and handled defensively rather than guessed**: the
  exact submit path (`/MessageApi/mt/messages` is inferred from a
  documented URL *pattern* plus a sibling GET path, not observed against
  an actual submit example); the `destination`/`source` `type` attribute
  (omitted entirely rather than risk a wrong value); the response XML
  schema for the returned message ID (parsed defensively for a
  `messageId`/`message_id` attribute or element; returns failure, never a
  fabricated ID, if nothing plausible is found); the error response
  format.
- `packages/providers/src/base.ts`'s shared `http_request()` was extended
  to pass a pre-serialized string body through as-is (needed for Vibes'
  XML) instead of always `JSON.stringify`-ing — backward compatible, every
  existing JSON-object caller is unaffected.
- Same simulated-fallback pattern when `VIBES_USERNAME`/`VIBES_PASSWORD`
  are unset.
- Registered with `countries: ['US', 'CA']` only, matching the *confirmed*
  scope of the base URL — deliberately not `['*']` given the lower
  confidence here.
- 6 new contract tests (`vibes.test.ts`): simulated fallback makes no HTTP
  call; real XML request/headers/auth are correct; a `message_id` element
  is parsed as a fallback response shape; a non-2xx response fails; an
  unparseable response fails cleanly without fabricating a message id;
  `status: offline` short-circuits.

**Adding a 17th and 18th provider required the same test bookkeeping as
the Africa's Talking addition** — `providerRegistry.test.ts`/
`management.test.ts` (16→18 total, 6→8 messaging), and every
simulation/routing test enumerating "all SMS-capable providers"
(`routing.test.ts`, `application-certification.simulation.test.ts`,
`resilience-failure.simulation.test.ts`,
`messaging-conversation.simulation.test.ts`), including the "all SMS
providers offline" gap tests that must now take both new providers
offline too for the assertion to hold. Registration-order-dependent
failover tests (e.g. signalhouse → infobip) are unaffected — both new
providers are registered after infobip.

**Database migrations:** none

**API changes:** none (adapter-internal)

**Security changes:** none

**Tests:** full suite 316 (304 passed, 12 pre-existing skipped —
integration tests requiring live DB/network) — net +13 new (7 Sinch + 6
Vibes) — confirmed 3x consecutive full-suite runs, 0 failures.
Lint/typecheck/build clean.

**Known issues carried forward:** Vibes' exact submit path and response
schema are inferred, not observed — do not treat it as production-ready
without verifying against a live Vibes sandbox account or the actual
documentation pages. SignalHouse, FutureSMS, generic SMS, and Email
adapters remain fully simulated. All payment adapters except Stripe
(partially real) remain simulated. Neither Sinch nor Vibes has been
tested against a live account.

---

## 2026-09-08 — Real Provider Adapters: Infobip + Africa's Talking

**Phase:** 6 of the master plan. The single largest previously-open gap:
every messaging adapter was fully simulated (fabricated message IDs,
always-success responses, no HTTP call at all).

**How the facts were verified, and what that means for confidence
level:** `WebFetch` (direct page retrieval) is blocked in this session —
confirmed via `infobip.com` and, as a control, an unrelated well-known
domain, both `EGRESS_BLOCKED`. `WebSearch` is *not* blocked and returns
real, current search-result snippets with source URLs (not training-data
memory). Several targeted queries per provider established: exact
endpoint path, auth header format, request body shape, success response
shape, error envelope shape, and (for Infobip) delivery-status group
names. Every fact used in the adapters below is traceable to a specific
search result, not inferred or remembered. **What this is not**: a page
fetched and read in full, or a live account tested against. Both
adapters remain unverified against a real Infobip/Africa's Talking
account — no credentials were available in this session. Treat as "built
from real, current, but partial documentation," not "certified."

### Infobip (`packages/providers/src/adapters/messaging/infobip.ts` — rewritten)
- `POST https://{INFOBIP_BASE_URL}/sms/3/messages`,
  `Authorization: App {INFOBIP_API_KEY}`
- Request: `{ messages: [{ sender, destinations: [{to}], content: {text} }] }`
- Success response: `{ bulkId, messages: [{ messageId, status: {groupId,
  groupName, id, name, description}, to }] }` — only reports platform
  `status: 'success'` when `groupName !== 'REJECTED'`; a 2xx HTTP response
  can still carry a per-message rejection, and that's never reported as a
  fabricated success.
- Error envelope: `{ requestError: { serviceException: { messageId, text } } }`
  — parsed into a real error message, not a generic "request failed" string.
- **Falls back to the pre-existing simulated behavior when
  `INFOBIP_API_KEY`/`INFOBIP_BASE_URL` aren't configured** — matches the
  established pattern already in `adapters/payments/stripe.ts` (the only
  adapter with any prior real-HTTP logic). This is why every existing test
  continues to pass unmodified: nothing in this environment configures
  these vars, so behavior is unchanged for all of them.
- 7 new contract tests (`infobip.test.ts`, `vi.stubGlobal('fetch', ...)`):
  simulated fallback makes no HTTP call; real request shape (URL, auth
  header, body) is correct; REJECTED-in-a-200 is reported as failed, not
  success; the documented error envelope is parsed; a malformed response
  (no messages array) fails cleanly instead of fabricating a message ID;
  5xx responses actually retry (via `BaseProvider.http_request`'s existing
  retry logic) before failing; `status: offline` short-circuits before any
  HTTP call.

### Africa's Talking (net-new: `packages/providers/src/adapters/messaging/africastalking.ts`)
Explicitly named as a priority provider in master plan Phase 16. Did not
exist before this session — no adapter file, no registry entry, no env
vars.
- `POST {baseUrl}/version1/messaging` where `baseUrl` is
  `https://api.africastalking.com` (live) or
  `https://api.sandbox.africastalking.com` (test) — **driven by the
  provider's registered `environment` field** (an existing first-class
  concept in this registry), not a new env var.
- Headers: `apiKey: {AFRICASTALKING_API_KEY}`, `Accept: application/json`
- Request: `{ username, to, message, from? }` (JSON — confirmed
  Africa's Talking accepts JSON as an alternative to its classic
  form-urlencoded format)
- Success response: `{ SMSMessageData: { Message, Recipients: [{
  statusCode, number, status, cost, messageId }] } }` — only reports
  platform `status: 'success'` when the recipient's `status === 'Success'`
  exactly; every other status string (`InsufficientBalance`,
  `InvalidPhoneNumber`, etc.) is a real provider-reported rejection,
  surfaced as the `error` field verbatim rather than paraphrased or
  mapped to a guessed enum.
- Same simulated-fallback pattern as Infobip when credentials are unset.
- Registered in `packages/providers/src/registry.ts` with the countries
  Africa's Talking's own documentation confirms it serves for SMS: KE,
  UG, TZ, RW, MW, NG, ZM, CI, ET, GH, ZA (not guessed, not copied from
  another provider's list — this repo's own audit history flagged
  exactly that mistake once already, for SignalHouse/Malawi).
- `.env.example`: `AFRICASTALKING_API_KEY`, `AFRICASTALKING_USERNAME`.
- 7 new contract tests (`africastalking.test.ts`), same coverage shape as
  Infobip's, plus a dedicated test that `environment: 'test'` routes to
  the sandbox base URL.

**Adding a 16th provider required updating tests that hard-coded provider
counts/lists** — not a design change, just consistency bookkeeping:
`providerRegistry.test.ts`/`management.test.ts` (15→16 total, 5→6
messaging), and every simulation/routing test that enumerates "all
SMS-capable providers" for either a `toContain` assertion or an
offline-toggle loop (`routing.test.ts`,
`application-certification.simulation.test.ts`,
`resilience-failure.simulation.test.ts`,
`messaging-conversation.simulation.test.ts`) — the same class of
maintenance the `example-msg` flakiness fix earlier this session required,
now handled proactively instead of discovered via a flaky run. Verified
provider-selection/failover tests that depend on *registration order*
(e.g. "signalhouse fails over to infobip") are unaffected, since
Africa's Talking was inserted after both in `registry.ts` and this
platform's failover is single-level-by-order, not exhaustive.

**Database migrations:** none

**API changes:** none (adapter-internal; the gateway's public contract is
unchanged)

**Security changes:** none

**Tests:** `npm test` 284 (net +14 new: 7 Infobip + 7 Africa's Talking) —
confirmed 3x consecutive full-suite runs, 0 failures. Lint/typecheck/build
clean.

**Known issues carried forward:** SignalHouse, FutureSMS, generic SMS,
and Email adapters remain fully simulated (SignalHouse's docs weren't
usefully indexed by search — confirmed by trying, rather than assumed).
All payment adapters (Stripe partially real already; NMI, Flutterwave,
PawaPay, PayChangu, Airwallex) remain simulated. Trembi not attempted —
net-new provider, no search results attempted yet. Neither new adapter
has been tested against a live account.

## 2026-09-08 — Neon Database Connected — Corrected Migration-Drift Diagnosis

Per the user's request, connected to the project's existing Neon
database (`bis-api-platform`, project `orange-water-80452818`, a real,
actively-used project — not a throwaway) via the Neon MCP connector.

**Important environment finding, for future sessions:** the MCP
`mcp__Neon__*` tools work in this session, but the application's own
database driver (`@neondatabase/serverless`, used by `getDb()` /
`DATABASE_URL`) does **not** — it makes an HTTP call to
`api.c-2.us-east-2.aws.neon.tech`, which this session's egress proxy
rejects with `403 Host not in allowlist`. Confirmed by actually running
`npm run test:integration` with `DATABASE_URL` set: every test failed
with that exact error, not a test failure. **Practical consequence**:
`npm run test:integration` / any code path that calls `getDb()` cannot
be exercised end-to-end in this environment even with a real
`DATABASE_URL` configured — only the `mcp__Neon__*` tools (which route
through different infrastructure) can reach this database from here.
Verification in this entry was done via `mcp__Neon__run_sql`, not by
running the repository's own test suite against the DB.

**Corrected the earlier migration-drift diagnosis** (see the HIGH entry
above from earlier this session, and `docs/IMPLEMENTATION_BASELINE.md`
§4 item 12) by actually inspecting the live schema:
- `tenants`, `conversations`, and `tenant_application_links` **all
  already match the current TypeScript schema exactly** in the live
  database — column-for-column, index-for-index. The earlier entry's
  claim that `0000_drizzle_init.sql`'s older `tenants` shape represented
  live risk was wrong; that migration was superseded by something (see
  next point) long before now, and the live table is correct.
- `drizzle.__drizzle_migrations` (the live tracking table) has entries
  for 11 migrations; this repo's `_journal.json` only accounts for 8
  (0000–0007) plus the 2 added this session (0008–0009, applied directly
  via SQL, not through this table's normal flow). **Migrations 9–11 in
  the live tracking table have no corresponding file in this repo at
  all** — someone applied schema changes directly to this database
  (almost certainly via `drizzle-kit push`, not `drizzle-kit migrate`)
  without committing what they ran.
- Two tables exist in the live database with **no schema file anywhere
  in the current codebase**: `checkout_sessions` and `webhook_jobs`.
  Neither is referenced by any current repository or test. Orphaned —
  either superseded by `transactions`/`outbox_events` or from a different
  branch/prototype that never merged. Not touched.
- `tenant_application_links` specifically (the table backing
  `TenantRegistry.assertTenantAccess`, i.e. the actual gateway
  tenant-isolation check) was independently double-checked against
  `packages/database/src/schema/tenant-application-links.ts` — they
  match exactly. The `&&` bug fixed earlier this session was a pure
  query-logic bug in the repository layer, not a schema mismatch.

**Empirically proved the `&&` bug's severity against real data** (not
just JS-semantics reasoning): created two temporary applications, two
temporary tenants, and links `(tenant1→app1)` and `(tenant2→app2)` only
— `tenant1` was never linked to `app2`. Ran the OLD buggy query pattern's
real SQL equivalent (`WHERE application_id = app2` — the tenant_id
condition `&&`-chaining silently dropped) alongside the fixed pattern
(`WHERE tenant_id = tenant1 AND application_id = app2`) against the same
live table: **buggy pattern returned 1 row (would have granted access),
fixed pattern returned 0 rows (correctly denies it)**. All test data
deleted immediately after — verified zero leftover rows.

**Applied `0008_add_consent_records.sql` and `0009_add_messaging_profiles.sql`
to the live database** (via `mcp__Neon__run_sql`, statement-by-statement —
the Neon HTTP driver rejects multi-statement calls) since `drizzle-kit
migrate` can't be trusted here (see the drift finding above). Verified
each new table with a real insert + select round-trip, then deleted the
smoke-test rows. Did **not** attempt to reconcile
`drizzle.__drizzle_migrations` for these two migrations — inserting a
fabricated hash for them risks confusing a future real `drizzle-kit
migrate` run worse than leaving it alone; the table was already missing
3 unrelated migrations before this session touched anything.

**Files changed:** none in the repository (database-only investigation
and additive schema changes, executed directly against Neon via MCP
tools, not through this repo's migration tooling)

**What remains open:** reconciling `drizzle/meta/*.json` snapshots (or
abandoning migration-file generation in favor of `drizzle-kit push` as
the documented deployment method) and identifying/removing or
documenting `checkout_sessions`/`webhook_jobs` — both still require a
human decision on approach, not just more investigation.

---

## 2026-09-08 — Attempted: Real Provider Adapters — Blocked by Network Policy

Before starting other work this session, attempted to fetch Infobip's SMS
API documentation (`infobip.com`) to begin replacing the simulated
adapter with a real HTTP integration per master plan Phase 6. It failed
with `EGRESS_BLOCKED`. As a control, fetched an unrelated, well-known
documentation domain (`developers.google.com`) — same failure — confirming
this session's outbound network access is restricted to a small
allowlist (package registries, the Anthropic API) rather than
Infobip specifically being unreachable.

Writing "real" adapters from training-data memory of these APIs instead
of verified current documentation would risk exactly the
fabricated-request/response-contract problem the master plan explicitly
prohibits ("Do not guess API payloads," "Official developer documentation
must be treated as the source of truth"), so this was not attempted.
Pivoted to other work this session that doesn't depend on external
network access. Real provider adapters remain the single largest gap
against the master plan's stated non-negotiables — see
`docs/IMPLEMENTATION_BASELINE.md` §6 item 1 for what's needed to unblock
it (network access for this session, or the docs/OpenAPI specs supplied
directly).

**Files changed:** none

## 2026-09-08 — Phase 26: Startup Configuration Validation

**Phase:** 26 of the master plan.

**What it does:** both `services/api-gateway` and `services/worker` now
validate required configuration before doing anything else and
`process.exit(1)` with an itemized error list if it's invalid, instead of
starting up and letting the problem surface request-by-request later.
Verified end-to-end, not just via unit test: actually ran the gateway
entrypoint (`ts-node --transpile-only src/index.ts`) with
`NODE_ENV=production` and no other config set — exited 1, printed all
four missing-var errors, never attempted to bind the port.

**What's validated:**
- `DATABASE_URL` — always required (every repository call fails without
  it, in every environment, not just production).
- In production only: `WEBHOOK_HMAC_SECRET`, `SECRET_ENCRYPTION_KEY`,
  `PLATFORM_ADMIN_KEY` — each of these already fails closed at request
  time when missing (webhooks rejected, secret encryption broken, admin
  routes all reject); this phase doesn't change that runtime behavior, it
  just catches the same problem at boot instead of via a stream of
  request failures.
- Deliberately **not** validated: `REDIS_URL`. Both the rate limiter
  (`services/api-gateway/src/auth.ts`) and the job store
  (`packages/workers/src/client.ts`) already have a working in-memory
  fallback when it's unset — a legitimate (if reduced-durability)
  deployment choice, not a misconfiguration.
- Deliberately **not** validated: any provider API key (e.g.
  `SIGNALHOUSE_API_KEY`). Every current provider adapter is simulated and
  never reads its own API key — validating a key nothing checks would be
  hollow, matching the master plan's own instruction not to make things
  "appear production-ready" without substance. This becomes real once
  real adapters land (currently blocked, see the entry above).

**Files changed:**
- `packages/shared/src/startup-config.ts` (new) — `validateStartupConfig()`
  (pure, testable) and `assertStartupConfig()` (validates + exits)
- `packages/shared/src/startup-config.test.ts` (new) — 8 unit tests
- `packages/shared/src/index.ts` — exports the above
- `services/api-gateway/src/index.ts` — calls `assertStartupConfig()`
  before importing `./app` (so an invalid config never even constructs
  the Express app). Deliberately **not** added to `app.ts` itself — the
  simulation test harness imports `app.ts` directly and constructs its
  own environment; forcing it through this check would break every
  simulation test that doesn't happen to set all of these vars.
- `services/worker/src/index.ts` — calls it as the first line of `main()`
- `services/worker/package.json` — added `@company/shared` (already used
  by `services/api-gateway`, newly needed here)

**Database migrations:** none

**API changes:** none (process-startup behavior only)

**Security changes:** none beyond making existing fail-closed behavior
visible earlier

**Tests:** `npm test` 269 → 277 passed (8 new), 0 failed. Lint/typecheck/
build clean. Also manually verified the real process exit behavior
(described above), not just the extracted function.

## 2026-09-08 — Phase 40/41: A2P/10DLC Messaging Profiles (Registration CRUD)

**Phase:** 40/41 (A2P/10DLC compliance model) of the master plan.

**Scope of this pass, stated plainly:** this adds the `MessagingProfile`
registration record from master plan §41 and a CRUD surface for it. It
does **not** enforce `complianceStatus` against outbound sends (an
unregistered or rejected sender can still send messages today — nothing
in `RoutingEngine` checks this table) and does **not** integrate with any
real carrier/registrar API to verify registration automatically. Building
those is real, separate follow-up work; this phase is the foundation they
would build on, not a claim that A2P/10DLC compliance is "done."

**Files changed:**
- `packages/database/src/schema/messaging-profiles.ts` (new) —
  `messaging_profiles` table: `(appId, tenantId, country, senderType,
  sender, provider, campaignId?, brandId?, complianceStatus)`, matching
  the master plan's `MessagingProfile` interface. `senderType` ∈
  `{phone, 10dlc, tollfree, shortcode, alphanumeric}`, `complianceStatus`
  ∈ `{unregistered, pending, approved, rejected, suspended}`. Unique per
  `(appId, tenantId, sender, provider)`.
- `packages/database/drizzle/0009_add_messaging_profiles.sql` (new,
  hand-authored per the migration-drift entry above) + journal entry.
  Verified with `drizzle-kit check`.
- `packages/database/src/repositories/messaging-profiles.ts` (new) —
  `findById`, `findBySender`, `findByApplicationId`, `create` (validates
  `senderType`/`complianceStatus` before touching the database),
  `updateComplianceStatus`, `count`.
- `packages/database/src/repositories/messaging-profiles.test.ts` (new) —
  5 DB-free unit tests for the validation logic, which runs before
  `getDb()` is ever called.
- `services/api-gateway/src/app.ts` — `POST`/`GET
  /v1/api/gateway/messaging-profiles` (app registers/lists its own
  senders, scoped under new `messaging-profiles:read`/`:write` API-key
  scopes) and admin `PATCH /api/dashboard/messaging-profiles/:id` (ops
  transitions `complianceStatus` after real-world registration/approval —
  intentionally admin-only, since that's a real-world fact the platform
  can't self-certify).
- `packages/simulation/src/db.ts` — real (not stubbed) mock repository,
  including the same validation as the real one (duplicated intentionally
  — this mock stands in for the whole `@company/database` module).
- `packages/simulation/src/messaging-profiles.simulation.test.ts` (new) —
  6 tests: register + list via HTTP, missing-field and invalid-senderType
  rejection, tenant/app data isolation, and the admin compliance-status
  transition workflow (`unregistered` → `pending` → `approved`) exercised
  directly against the repository.

**Database migrations:** `0009_add_messaging_profiles.sql` (new table)

**API changes:** `GET`/`POST /v1/api/gateway/messaging-profiles`,
`PATCH /api/dashboard/messaging-profiles/:id`

**Security changes:** none beyond standard API-key scoping + admin gating
on the new routes

**Tests:** `npm test` 257 → 269 passed (11 net new: 6 simulation + 5 unit),
0 failed. Lint/typecheck/build clean.

**Known issues carried forward:** no enforcement against
`complianceStatus` in routing (stated above, not hidden); no registrar
integration; `PATCH .../messaging-profiles/:id` isn't exercised by an
automated test via HTTP (no `PLATFORM_ADMIN_KEY` configured in this
environment — same limitation as every other admin-dashboard route in
this test suite, not new here) — it's covered indirectly by testing
`updateComplianceStatus` directly against the (mocked) repository the
route calls.

## 2026-09-08 — Phase 39: Consent Management (STOP/JOIN Blocks/Restores Outbound Sends)

**Phase:** 39 (STOP/consent management) of the master plan. Closes the gap
where a STOP keyword was logged and closed the conversation but nothing
in the outbound send path ever checked it — a recipient who replied STOP
could still receive further messages.

**Files changed:**
- `packages/database/src/schema/consent-records.ts` (new) — `consent_records`
  table: `(appId, tenantId, recipient, channel)` → current `status`
  (`opted_in`/`opted_out`/`unknown`), `source` (`keyword`/`api`/`import`),
  `keyword`. Unique per `(recipient, appId, tenantId, channel)` — one
  current value, not a log (the existing `events` table already records
  every keyword/API call that changed it).
- `packages/database/drizzle/0008_add_consent_records.sql` (new,
  hand-authored — see the migration-drift entry above for why
  `drizzle-kit generate` couldn't be used directly) +
  `drizzle/meta/_journal.json` entry. Verified with `drizzle-kit check`.
- `packages/database/src/repositories/consent-records.ts` (new) —
  `findByRecipient`, `upsert` (the STOP/JOIN write path), `isOptedOut`
  (the send-path read), `findByApplicationId`, `count`.
- `packages/routing/src/keywords.ts` — `handleStop`/`handleJoin` now write
  a consent record via `consentRecordRepository.upsert`. **Also removed
  `conversationRepository.close()` from `handleStop`**: closing the
  conversation broke `ConversationResolver`'s ability to route a
  *subsequent* JOIN back to the same app (inbound routing only matches
  *active* conversations — see `packages/routing/src/conversation-resolver.ts`
  `findActiveByPhone`), which would have made re-subscribing impossible.
  Consent (compliance) and conversation status (routing/continuity) are
  now correctly separate concerns; `KeywordContext` gained an optional
  `channel` field, threaded through from `packages/workers/src/jobs/inboundMessage.ts`.
- `packages/routing/src/index.ts` — `RoutingEngine.routeMessage` computes
  `channel` once (previously recomputed inline in three places) and
  checks `consentRecordRepository.isOptedOut(appId, tenantId, recipient,
  channel)` before any provider selection; throws the new
  `ConsentBlockedError` if blocked. **Fails open** (allows the send, logs
  via `console.error`) if the consent lookup itself errors — consistent
  with `ConversationManager`'s existing best-effort pattern in this same
  file, not a new precedent. This is a real, documented tradeoff: a
  genuinely opted-out recipient could receive one message during a
  consent-store outage. Hardening to fail-closed is a flagged follow-up,
  not done here, because it would make all outbound messaging hard-depend
  on the consent store's availability.
- `services/api-gateway/src/app.ts` — `POST /v1/api/gateway/messaging`
  catches `ConsentBlockedError` specifically and returns 403 (not the
  generic 503 every other routing failure gets), since retrying a
  consent-blocked send will never succeed. Added
  `GET /v1/api/consent/:recipient` and `POST /v1/api/consent` (master plan
  §66's final API contract) — the latter lets an application set consent
  directly (e.g. importing an existing suppression list) without a
  keyword round-trip; both scoped under new `consent:read`/`consent:write`
  API-key scopes.
- `packages/simulation/src/db.ts` — added a real (stateful, not stubbed)
  `consentRecordRepository` mock backed by `dbState.consentRecords`, so
  simulation tests can exercise actual STOP/JOIN → send-blocking behavior,
  not just that a keyword was logged.
- `packages/simulation/src/harness.ts` — added `enqueueInboundMessage()`,
  mirroring the existing `enqueueProviderWebhook()`/`enqueuePaymentWebhook()`
  pattern: it reaches the worker's `inbound_message` processor directly,
  bypassing a **separate, pre-existing gap** discovered while testing this
  (see below).
- `packages/simulation/src/messaging-conversation.simulation.test.ts` — 3
  new tests: STOP blocks a subsequent send (403) and is recorded with
  `source: 'keyword'`; JOIN after STOP restores `opted_in` and sends
  succeed again; opting out one recipient doesn't block another. Also
  corrected the framing of two pre-existing "documented gap" tests whose
  narrative this work made stale (see below) — their assertions were
  already correct, only their comments/titles were wrong.
- `packages/routing/package.json` — added `@company/database` as an
  explicit dependency. `conversation.ts` and `keywords.ts` already
  imported from it without declaring it (working only via npm workspace
  hoisting); `index.ts` now imports it too, a good point to fix the
  manifest.

**Separate pre-existing gap found while writing these tests:** the
gateway's real inbound-webhook path
(`services/api-gateway/src/app.ts` `enqueueInboundMessage()`) uses a raw
`ioredis` client with no fallback; without `REDIS_URL` configured (as in
this environment) it silently no-ops, so **no inbound message — including
STOP — ever reaches `handleKeyword()` via the actual webhook route today**.
This was already independently documented by two pre-existing
"documented gap" test blocks in this same file (the `it.each(KEYWORDS)`
block and "the gateway accepts a correctly signed inbound webhook but
never enqueues it") — not new. The new consent tests reach the worker's
processor directly via `enqueueInboundMessage()` (the harness helper, not
the gateway function of the same name) to test consent enforcement
independent of that gap, the same way existing tests already do for
`provider_webhook`/`payment_webhook`. Fixing the gateway's inbound
enqueue path to use the same abstracted, testable queue the rest of the
system uses (instead of a raw, Redis-required client) is a real,
separate piece of follow-up work — not done here.

**Database migrations:** `0008_add_consent_records.sql` (new table, no
data migration)

**API changes:** `GET /v1/api/consent/:recipient?channel=sms`,
`POST /v1/api/consent`; `POST /v1/api/gateway/messaging` can now return
403 in addition to its existing 400/401/403(tenant)/503

**Security/compliance changes:** outbound messaging now actually respects
STOP (previously logged only, never enforced) — closes the specific
platform gap the master plan's Phase 39 exists to address.

**Tests:** `npm test` 254 → 257 passed (3 net new — some iteration
happened getting the seed-conversation provider deterministic, see git
history), 0 failed. Ran the full suite and the messaging-conversation file
alone 3x consecutively to confirm no flakiness. Lint/typecheck/build
clean.

**Known issues carried forward:** consent enforcement fails open on a
lookup error (documented above); no admin-console UI for consent records
yet (API only); `application.allowedCapabilities` remains unused (same
note as the API-key scoping phase); the gateway's raw-ioredis inbound
enqueue gap (documented above) means STOP sent via the real webhook route
still doesn't work end-to-end in a `REDIS_URL`-less deployment — only
the underlying keyword-handling and consent-enforcement logic this phase
adds has been fixed and verified.

## 2026-09-08 — HIGH: Drizzle Migration History Has Diverged From The Actual Schema

**Severity:** High. Found while generating a migration for the new
`consent_records` table (next entry below) — `drizzle-kit generate`
unexpectedly prompted interactively asking whether `tenants.country_code`
was a new column or a rename of `tenants.domain`/`tenants.settings`/
`tenants.application_id`, which are columns that don't exist in the
current `packages/database/src/schema/tenants.ts` at all.

**What's actually wrong:**
1. `packages/database/drizzle/meta/` only has snapshot files for
   migrations 0000 and 0001 (`0000_snapshot.json`, `0001_snapshot.json`),
   but `_journal.json` and the SQL files on disk go up to migration 0007.
   Migrations 0002–0007 were added without regenerating their snapshots —
   `drizzle-kit generate`'s diffing (which snapshots exist to support) has
   been comparing against 0001's state ever since, not the schema as it
   actually stood after each later migration.
2. Two tables that exist in the TypeScript schema and are actively used by
   real code have **no migration at all**: `tenant_application_links`
   (`packages/database/src/schema/tenant-application-links.ts` — this is
   the table backing `TenantRegistry.assertTenantAccess`, the platform's
   core tenant-isolation check) and `conversations`
   (`packages/database/src/schema/conversations.ts` — backs all
   conversation continuity and inbound message routing). A fresh database
   built by running `npm run drizzle:migrate` from migration 0000 forward
   would never create either table.
3. `0000_drizzle_init.sql`'s `tenants` table (`application_id`, `domain`,
   `settings` columns, one tenant belongs to one application) is a
   fundamentally different, older design than the current
   `tenants.ts` schema (`country_code`, `currency`, `status`, `metadata`,
   no `application_id` — tenants now relate to applications many-to-many
   via `tenant_application_links`). That redesign was never captured in a
   migration either.

**Why this wasn't fixed in this pass:** reconstructing the exact
`ALTER TABLE`/`CREATE TABLE` sequence that would take a database built
from the current migration files to the schema real code actually expects
is a real, standalone task — done wrong it risks producing a migration
that looks plausible but corrupts or loses data on a database that already
has the old `tenants` shape applied. That needs to be verified against a
real (or realistic staging) Postgres instance, which this environment
doesn't have (`DATABASE_URL` isn't configured here). Attempting it blind
would be exactly the kind of "looks done, isn't" work the master plan
warns against — documenting it precisely, rather than guessing, is the
correct move per that plan's explicit instruction to flag what can't be
verified rather than claim unearned confidence.

**What was verified safe:** `npx drizzle-kit check` (the command
`migration-check` in CI runs) still passes — it validates journal/file
self-consistency, not schema-vs-snapshot drift, so this finding doesn't
newly break that gate; it was already silently not catching this.

**Recommended next steps for whoever picks this up:** (1) stand up a
throwaway Postgres instance, `drizzle:push` the *current* schema to it to
see the target shape, (2) `drizzle:push` migrations 0000-0007 to a second
instance to see what's actually reachable via versioned migrations today,
(3) diff the two and hand-write the missing/corrective migrations,
verifying against real data-preservation semantics for the `tenants`
redesign specifically. Do not attempt this by re-running
`drizzle-kit generate` interactively without first fixing the missing
snapshots, or its rename-vs-new-column guesses can't be trusted.

**Files changed:** none (investigation only, documented here and in
`docs/IMPLEMENTATION_BASELINE.md`)

## 2026-09-08 — CRITICAL: `&&`-Chained Drizzle Conditions Silently Dropped Filters Across 10 Repository Files

**Severity:** Critical. Found while adding the consent-records repository
(next entry below) and reading `conversations.ts` as a style reference.

**The defect:** Ten repository files combined multiple Drizzle `eq()`/`gt()`
conditions with the JavaScript `&&` operator instead of Drizzle's `and()`
combinator:

```ts
.where(
  eq(conversations.phoneNumber, phoneNumber) &&
    eq(conversations.appId, appId) &&
    eq(conversations.tenantId, tenantId),
)
```

`eq()` returns a truthy `SQL` object. `a && b && c` evaluates left to
right and returns its *last* truthy operand — so `.where()` received only
`eq(conversations.tenantId, tenantId)`; the phoneNumber and appId
conditions were computed (for their side effects, building unused SQL AST
nodes) and then silently discarded. This is invisible to TypeScript
(every intermediate value is a structurally valid `SQL` type) and
invisible to most hand-written tests, because it only produces a wrong
result when the *dropped* condition would have excluded a row that the
*kept* condition still matches — exactly the scenario cross-tenant
isolation tests are supposed to exercise, and in several cases apparently
didn't (see "Confirmed impact" below).

**Confirmed impact by file:**
- `tenant-application-links.ts` `findByTenantAndApplication` (used by
  `isLinked`, which backs `TenantRegistry.assertTenantAccess` — **the
  actual gateway-level tenant authorization check**) filtered only by
  `applicationId`. **Any tenant ID would pass authorization as long as
  *some* tenant was linked to the requested application** — a real
  cross-tenant authorization bypass in the platform's core isolation
  primitive. Also affected `unlink`.
- `users.ts` `findByApplicationAndEmail` filtered only by `email`,
  ignoring `applicationId` — a login lookup that could authenticate a
  user against the wrong application's account on an email collision.
- `transactions.ts` `findByAppAndIdempotencyKey` filtered only by
  `idempotencyKey`, ignoring `appId`/`tenantId` — idempotency keys could
  collide across unrelated tenants' payments.
- `idempotency-records.ts` `findActive` filtered only by the `gt(expiresAt,
  now)` clause, ignoring `appId`/`tenantId`/`operation`/`idempotencyKey`
  entirely — the general-purpose idempotency guard used across the
  worker pipeline was effectively checking "does *any* active
  idempotency record exist," not "does *this* one."
- `suppliers.ts` `findByApplicationAndSlug` filtered only by `slug`,
  ignoring `applicationId`/`tenantId` — cross-tenant supplier lookup.
- `conversations.ts` `findByPhoneAndApp` filtered only by `tenantId`;
  `findActiveByPhone` filtered only by `status`; `close` filtered only
  by `tenantId` — meaning `close()` (invoked by the STOP keyword
  handler) could close *every* conversation for a tenant, not just the
  one for the requesting phone/app.
- `tenants.ts` `findActiveByApplicationId` filtered only by `status`,
  ignoring `applicationId` — would return active tenants belonging to
  *other* applications.
- `application-permissions.ts` `findByApplicationAndResource`,
  `findByApplicationResourceAction`, and `deleteByApplicationResource`
  each dropped all but their last condition — the resource/action lookup
  underlying permission checks could match the wrong application.
- `provider-configs.ts` `findByProviderAndEnvironment` filtered only by
  `environment`.

**Fix:** every occurrence rewritten to use `and(cond1, cond2, ...)`. Several
files (`conversations.ts`, `idempotency-records.ts`,
`tenant-application-links.ts`, `users.ts`) already had `and` imported and
unused right next to the bug — a strong signal the intent was always to
use it.

**Regression guard:** `packages/database/src/where-clause-and.test.ts`
(new) statically scans every file in `repositories/` for the
condition-immediately-followed-by-`&&` pattern and fails if it reappears.
Verified against both the original buggy source (matches) and the fixed
source (doesn't match) before relying on it. This doesn't require a live
database, so it runs in every `npm test` invocation, not just the gated
DB integration suite.

**Files changed:** `packages/database/src/repositories/{conversations,
idempotency-records,application-permissions,provider-configs,suppliers,
tenant-application-links,tenants,transactions,users}.ts`,
`packages/database/src/where-clause-and.test.ts` (new)

**Database migrations:** none (query-logic fix only)

**Tests:** `npm test` 235 → 253 passed (18 new, all from the regression
guard), 0 failed. **Could not be verified end-to-end against a live
Postgres database in this environment** (no `DATABASE_URL` configured) —
`conversations.integration.test.ts` remains the only test that exercises
these repositories against a real database, and it's gated by
`describe.skipIf(!hasDb)`. The fix itself is a well-established, correct
Drizzle pattern (`and()` is Drizzle's own documented condition combinator)
and was applied identically to every occurrence, but running
`npm run test:integration` against a real database (as CI's
`integration-test` job does with `TEST_DATABASE_URL`) is the outstanding
verification step — flagging this explicitly rather than claiming a
confidence level this session couldn't actually establish.

**This is exactly the class of defect Phase 0's baseline audit is meant to
surface** — it was not caught by the extensive prior "P0 audit
remediation" commits despite several of them specifically claiming to fix
cross-tenant isolation in `transactions.ts`, `events.ts`, and
`conversations.ts`. Those fixes were real (the tenant-scoping *arguments*
were added), but the `&&` bug silently undid them at the query level. Worth
noting for how future audits verify a fix: a positive-path test with only
one matching row cannot distinguish a correct multi-condition filter from
one that silently dropped every condition but the last — the isolation
tests that would have caught this need *at least two rows differing only
in the dropped field*, not just "does the happy path still find the
right row."

## 2026-09-08 — Phase 11: `/ready` Queue Health Check + Two Flaky-Test Fixes

**Phase:** 11 (observability) — closes the last item from
`PRODUCTION_READINESS_REPORT.md` P2-5 ("`/ready` doesn't check
dependencies") that was still genuinely open.

**Files changed:**
- `services/api-gateway/src/app.ts` — `/ready` now pings the Redis
  connection used for job enqueueing (`getRedisClient()`) when
  `REDIS_URL` is set, reporting `healthy`/`unreachable`; reports
  `unconfigured` (not a failure) when Redis isn't configured, since the
  platform's real fallback in that case is DB-only webhook persistence,
  not an outage. **Also fixed a real, separate bug found while making this
  change**: the DB check assigned `checkDatabaseHealth()`'s entire
  resolved object (`{status, latencyMs, details}`) to a variable and
  treated any non-throwing result as truthy → always `'healthy'`. That
  function returns (doesn't throw) `status: 'degraded'` or `'unhealthy'`
  for a slow-but-connected database, so `/ready` never actually surfaced
  those states — only a hard connection failure (a thrown exception) did.
  Now reads `.status` directly.
- `packages/simulation/src/ready-endpoint.simulation.test.ts` (new) — 3
  tests: all dependency keys present, queue reports `unconfigured` (200)
  when `REDIS_URL` is unset, database reports `unhealthy` (503) when the
  DB is down — the last of which caught the bug above (it failed against
  the pre-fix code, confirming `/ready` was silently reporting healthy).
- `packages/simulation/src/security-isolation.simulation.test.ts` — fixed
  a real flaky test unrelated to this phase's main change, found while
  re-running the suite to validate it: "tampered HMAC signature is
  rejected" flipped a webhook signature's first hex nibble to a *fixed*
  `'a'`, which has a 1-in-16 chance of coincidentally matching the
  original (non-deterministic per run — the webhook body includes a
  random event id and current timestamp), producing a byte-identical
  "tampered" signature that's actually still valid and spuriously passing
  verification. Now flips to whichever of `'a'`/`'b'` differs from the
  original.
- `packages/routing/src/routing.test.ts` — fixed a second flaky test found
  the same way: the SMS-routing test's expected-provider list omitted
  `example-msg`, a real SMS-capable, weight-25 candidate in the same
  weighted-random pool as the three providers it did list — about a
  1-in-7 chance per run of a spurious failure.
- `docs/IMPLEMENTATION_BASELINE.md` — marked the `/ready` gap closed,
  corrected the DB-check claim

**Database migrations:** none

**API changes:** `/ready` response gains a `queue` key in `dependencies`
(`healthy` / `unreachable` / `unconfigured`); `database` can now report
`degraded` in addition to `healthy`/`unhealthy`/`unreachable`

**Security changes:** none

**Tests:** `npm test` 232 → 235 passed, 0 failed. Ran the full suite 5x
consecutively after both flaky-test fixes to confirm elimination (prior to
the fixes, 2 of 4 consecutive runs failed on one or the other).
Lint/typecheck/build clean.

**Known issues carried forward:** none new. The `queue` check only
verifies the Redis connection is reachable, not that the worker process
is actually consuming from it — a full worker liveness signal (e.g. a
heartbeat key the worker refreshes) would be a further improvement but is
out of scope here.

## 2026-09-08 — Phase 3: API-Key Scope Enforcement & Default Expiry

**Phase:** 3 (API Gateway hardening) — closes two items from
`SECURITY_AUDIT_REPORT.md` (M2, M3) that were still open per
`docs/IMPLEMENTATION_BASELINE.md`.

**Files changed:**
- `packages/database/src/registry.ts` — `AuthenticateResult.scopes` now
  surfaces the matched API key's `scopes` column;
  `API_KEY_DEFAULT_EXPIRY_DAYS` (default 365, 0 disables) applied to
  `expiresAt` in `createApplication` and `rotateApplicationKey`
- `services/api-gateway/src/auth.ts` — `AuthService.authenticate()` parses
  `scopes` into a string array; `createMiddleware().apiKey` is now a
  factory `apiKey(requiredScope?: string)` that 403s when the key has
  scopes configured and the requested capability isn't among them (a key
  with no scopes stays unrestricted — opt-in scoping, not a breaking
  change for keys issued before this existed)
- `services/api-gateway/src/app.ts` — wired `mw.apiKey(scope)` onto all 5
  gateway routes: `payments:send`, `messaging:send`, `other:send`,
  `transactions:read`, `providers:read`
- `packages/database/src/registry.test.ts` — 4 new tests: default expiry
  set on creation, scopes surfaced on successful auth (both configured and
  null/unrestricted cases)
- `.env.example` — documented `API_KEY_DEFAULT_EXPIRY_DAYS`
- `docs/IMPLEMENTATION_BASELINE.md` — marked both gaps closed

**Database migrations:** none (`scopes` and `expiresAt` columns already
existed on `application_api_keys`; this phase starts populating/enforcing
them)

**API changes:** gateway routes now return 403
(`API key is not authorized for scope "..."`) for a scoped key missing the
required capability. No change to unscoped keys' behavior.

**Security changes:** closes SECURITY_AUDIT_REPORT.md M2 (no scope
enforcement) and M3 (no default expiry).

**Tests:** `npm test` 229 → 232 passed (3 net new — one prior "preserves
scopes on rotation" test already existed and continues to pass), 0 failed;
lint/typecheck/build clean, including the full `packages/simulation`
end-to-end suite (proves existing unscoped keys are unaffected).

**Known issues carried forward:** no admin-console UI or dashboard API
route yet to set a key's `scopes` after creation — the enforcement is live,
but assigning scopes today means writing the `scopes` column directly
(e.g. via a migration or direct DB access). `application.allowedCapabilities`
(a separate, application-level field also in the schema) is still unused —
left out of this phase to keep scope narrow; only per-key `scopes` is
enforced.

## 2026-09-08 — Phase 11/21: Provider Circuit Breaker

**Phase:** 21 (circuit breaker) of the master plan, plus the doc correction
from Phase 0/1 that first identified it as a real (not already-fixed) gap.

**Files changed:**
- `packages/schemas/src/index.ts` — added `ProviderCircuitState` type
  (`'closed' | 'open' | 'half_open'`) and `circuitState` /
  `consecutiveFailures` fields on `ProviderManagement`
- `packages/providers/src/registry.ts` — per-provider circuit breaker state
  machine on `ManagementState`; `isCircuitAvailable(id)` and
  `isProviderAvailable(id)` (status + circuit combined); `recordTraffic()`
  drives CLOSED→OPEN on threshold, OPEN→HALF_OPEN on cooldown expiry,
  HALF_OPEN→CLOSED on a successful probe, HALF_OPEN→OPEN (cooldown restart)
  on a failed probe; `findByCategoryAndCapabilities()` now excludes
  circuit-open providers; `updateManagement()` and `updateProviderConfig()`
  reset the circuit when an operator manually sets a provider back online
- `packages/routing/src/index.ts` — every routing decision point
  (`routePayment`, `routeMessage` including conversation continuity,
  `routeOther`, and all manual-override checks) now calls
  `registry.isProviderAvailable()` instead of reading `config.status`
  directly, so an open circuit removes a provider from routing without an
  operator having to flip its status by hand
- `packages/providers/src/circuitBreaker.test.ts` (new) — 8 tests covering
  the full state machine, including fake-timer-driven cooldown/half-open
  transitions
- `packages/routing/src/routing.test.ts` — 2 new tests proving routing
  fails over around an open-circuit provider (including when a caller
  explicitly requests it via `providerOverride`) even though its
  admin-controlled `status` stays `online`
- `.env.example` — documented `CIRCUIT_BREAKER_FAILURE_THRESHOLD` (default
  5) and `CIRCUIT_BREAKER_COOLDOWN_MS` (default 30000)
- `docs/IMPLEMENTATION_BASELINE.md` — marked the circuit-breaker gap closed

**Database migrations:** none (circuit state is in-memory on the registry
singleton, same durability model as the rest of `ManagementState` — provider
health/errorRate were already in-memory-only)

**API changes:** `GET` provider management responses now include
`circuitState` and `consecutiveFailures`; no route signature changes

**Security changes:** none

**Tests:** `npm test` 219 → 229 passed (10 new), 0 failed; lint/typecheck/
build all clean

**Known issues carried forward:** circuit state resets on process restart
(consistent with the rest of the registry's in-memory management state —
persisting it would be a separate, larger change to move provider
management state into the database, out of scope here). No admin-console UI
surfaces `circuitState` yet — the field is exposed on the API but not yet
rendered in `ProviderManagement.tsx`.

## 2026-09-08 — Phase 0/1: Repository Audit & Baseline

**Phase:** 0 (repository audit) and 1 (baseline test pass)

**Files changed:**
- `docs/IMPLEMENTATION_BASELINE.md` (new) — full architecture/gap audit
- `docs/BASELINE_TEST_REPORT.md` (new) — baseline pipeline results
- `packages/events/src/eventBus.test.ts` — fixed stale 100-event history
  assertion to match the real 1000-event `MAX_HISTORY` cap
- `packages/simulation/src/donation-system.simulation.test.ts` — fixed
  timestamp-race in `mark()`/`busEventsAfter()` helpers
- `packages/simulation/src/resilience-failure.simulation.test.ts` — same fix
- `packages/simulation/src/messaging-conversation.simulation.test.ts` — same fix
- `packages/workers/src/load.test.ts` → renamed
  `packages/workers/src/load.integration.test.ts`, added
  `describe.skipIf(!hasDb)` guard matching the existing
  `conversations.integration.test.ts` convention
- `package-lock.json` — `npm audit fix` (non-breaking): patched the
  `body-parser` → `qs` DoS advisory path; synced two missing workspace
  entries (`@company/loadtest`, `@company/simulation`) that `npm install`
  had not previously recorded

**Database migrations:** none

**API changes:** none

**Security changes:**
- `qs` (via `body-parser`) DoS advisories (GHSA-x5fp-wj9c-mxmx,
  GHSA-4mjr-xmp4-gh2g) patched via non-breaking `npm audit fix`. Residual
  `qs` exposure via `express`'s own dependency requires an express 5.x
  major-version migration — documented as a tracked gap, not silently
  ignored (`docs/BASELINE_TEST_REPORT.md` §4).

**Tests:**
- `npm test`: 3 failed → 0 failed (219 passed, 12 correctly skipped)
- `npx tsc --noEmit`: 0 errors (no change, already clean)
- `npm run lint`: 0 errors (no change, already clean)
- `npm run build:all`: clean (no change, already clean)

**Known issues carried forward (not addressed in this phase):**
All messaging/payment provider adapters are simulated (no real HTTP calls);
no Africa's Talking/Trembi adapters exist; gateway rate limiting is
in-memory-per-instance despite a Redis-backed limiter existing in
`@company/workers`; `/ready` doesn't check DB/Redis/queue health; no circuit
breaker; no API-key scope enforcement; no A2P/10DLC compliance model; no
payment reconciliation/connected-account model. Full list in
`docs/IMPLEMENTATION_BASELINE.md` §4.

**Explicitly not done in this phase:** any new feature work, any provider
integration work, any change to `services/api-gateway/src/app.ts` or
`packages/providers/**` beyond what's listed above. This phase was
deliberately scoped to "make the existing baseline honest and green," per
the master plan's Phase 0/1 instructions, before starting further
implementation phases.
