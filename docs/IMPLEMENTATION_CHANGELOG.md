# BIS API Platform — Implementation Changelog

Chronological record of implementation phases against the master
production-readiness plan. Each entry lists what changed, why, and what
tests cover it.

---

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
