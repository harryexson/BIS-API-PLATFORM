# BIS API Platform — Implementation Changelog

Chronological record of implementation phases against the master
production-readiness plan. Each entry lists what changed, why, and what
tests cover it.

---

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
