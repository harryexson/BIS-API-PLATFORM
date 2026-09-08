# BIS API Platform — Implementation Changelog

Chronological record of implementation phases against the master
production-readiness plan. Each entry lists what changed, why, and what
tests cover it.

---

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
