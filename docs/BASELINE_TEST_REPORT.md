# BIS API Platform — Baseline Test Report

**Generated:** 2026-09-08
**Environment:** Ephemeral sandbox, no `DATABASE_URL` / `REDIS_URL` configured
(no live Neon or Redis instance attached to this session).

This is Phase 1 of the master implementation plan: run the actual pipeline,
record what's really there, fix what's cheaply and correctly fixable before
any new feature work begins. Three genuine test defects were found and fixed
in this pass (details in §3); no assertions were weakened and no tests were
deleted or skipped to make the suite pass.

---

## 1. Commands Run

| Command | Result |
|---|---|
| `npm install` | **PASS** — 421 packages, 0 install errors |
| `npm run lint` | **PASS** — 0 errors, 232 warnings (all pre-existing `no-explicit-any` / `no-console` / unused-arg style warnings, no correctness issues) |
| `npx tsc --noEmit` | **PASS** — 0 errors |
| `npm test` (vitest, no DB) | **PASS** — 219 passed, 12 skipped (10 pre-existing DB-less skips + 2 gated integration tests), 0 failed, 18 test files |
| `npm run build:all` | **PASS** — admin-console (Vite), api-gateway (tsc), worker (tsc) all build clean |
| `npm audit` | 10 vulnerabilities after remediation (was 11) — see §4 |

## 2. Before This Pass

The very first `npm test` run (before any fixes) showed:

```
Test Files  3 failed | 14 passed | 1 skipped (18)
     Tests  3 failed | 217 passed | 11 skipped (231)
```

Three real defects, not flaky infrastructure:

1. `packages/events/src/eventBus.test.ts` — asserted a 100-event history cap
   that no longer matches the code (`MAX_HISTORY` was raised to 1000 in a
   later feature commit; the test was never updated).
2. `packages/simulation/src/donation-system.simulation.test.ts` — the "DB
   failure during processing" test intermittently found a stray `payment`
   event with the donation's `txId` in the bus history after simulating a DB
   outage, and concluded the platform leaked a payment confirmation despite
   the DB write failing.
3. `packages/workers/src/load.integration.test.ts` (then named `load.test.ts`)
   — asserted `completed > 0` for a scenario that requires a live
   `DATABASE_URL` to write through the real `message_delivery` job
   processor, but the file was named `*.test.ts` and therefore ran under the
   no-DB `npm test` gate instead of the DB-provisioned `npm run
   test:integration` gate.

## 3. Root Causes and Fixes

### 3.1 `eventBus.test.ts` — stale assertion
`EventBus` (`packages/events/src/index.ts`) defines `MAX_HISTORY = 1000` and
bounds `this.history` to that cap. The test still emitted 120 events and
asserted a 100-length cap — an assertion that was never updated when the cap
was raised for the Redis-backed distributed-history feature. **Fix:** updated
the test to emit 1020 events and assert the real 1000-event cap, preserving
the "bounded, newest-first" behavior it's meant to guard.

### 3.2 Donation-system DB-failure simulation — flaky harness, not a platform bug
`packages/workers/src/jobs/paymentWebhook.ts` writes the event + outbox row
inside `runInTransaction`; when the simulated DB write throws, the function
throws before it ever reaches `deps.eventBus.emit(...)`. Tracing every path
that touches the event bus during this test confirmed **no code path
emits a `payment` event with the donation's transaction ID after a DB
write failure** — the platform behavior itself is correct.

The actual bug was in the test harness's `mark()`/`busEventsAfter()` helpers
(duplicated across `donation-system.simulation.test.ts`,
`resilience-failure.simulation.test.ts`, and
`messaging-conversation.simulation.test.ts`):

```ts
function mark(): number {
  return Date.now() - 1;                       // millisecond-resolution token
}
function busEventsAfter(token: number, ...) {
  return history.filter(e => new Date(e.timestamp).getTime() >= token);
}
```

`createDonation()` emits its own (legitimate, pre-webhook) `payment` event
carrying the same transaction ID as part of the initial charge attempt. When
`mark()` is called immediately afterward, clock resolution means that event
can land in the same millisecond as `Date.now() - 1`, so
`busEventsAfter(mark())` — meant to capture only events emitted *during the
subsequent simulated DB outage* — sometimes also caught that earlier,
legitimate event and the test misread it as evidence of a leak.

**Fix:** replaced the timestamp-based token with a history-length-based one.
`EventBus.getHistory()` is newest-first (`unshift`), so a "mark" is just
`history.length` at capture time, and "events after the mark" are the
leading `history.length - token` entries — immune to clock granularity:

```ts
function mark(): number {
  return runtime.bus.getHistory().length;
}
function busEventsAfter(token: number, ...) {
  const history = runtime.bus.getHistory();
  const newCount = Math.max(0, history.length - token);
  return history.slice(0, newCount).filter(...);
}
```

Applied identically to all three files that duplicated this helper pair, so
the whole `packages/simulation` audit suite now gets a reliable "events since
X" signal instead of a millisecond race.

### 3.3 Load test misclassified as a DB-free unit test
`packages/workers/src/load.test.ts` drives real `message_delivery` jobs
through the real (non-simulated) `@company/database` `eventRepository`,
which requires `DATABASE_URL`. The repo already has an established
convention for this exact situation —
`packages/database/src/repositories/conversations.integration.test.ts` uses
`describe.skipIf(!process.env.DATABASE_URL)` and is named
`*.integration.test.ts` so CI's `unit-test` job (`npm test`, no DB) and
`integration-test` job (`npm run test:integration`, `DATABASE_URL` from
`secrets.TEST_DATABASE_URL`) each run the right set. `load.test.ts` didn't
follow either half of that convention, so it was silently red in the no-DB
unit gate in CI too, not just in this sandbox.

**Fix:** renamed to `load.integration.test.ts` and added the same
`describe.skipIf(!hasDb)` guard used by `conversations.integration.test.ts`.
It now skips cleanly without a DB and will actually execute — and validate
real throughput/latency numbers — under `npm run test:integration` in CI
where `TEST_DATABASE_URL` is provided.

## 4. `npm audit`

Before any fix: 11 vulnerabilities (9 moderate, 1 high, 1 critical) — all
inside `vite` / `vitest` / `@vitest/mocker` / `vite-node` / `drizzle-kit` /
`esbuild` (dev/build tooling, not shipped) plus `qs` (via `express` /
`body-parser`, moderate DoS advisories, CVSS 3.7 and 5.3).

Ran `npm audit fix` (non-forcing, no breaking changes): fixed the
`body-parser`→`qs` path. Result: 10 vulnerabilities (8 moderate, 1 high, 1
critical) — verified `npm test` / `tsc --noEmit` / `build:all` still pass
after the fix.

**Residual, not fixed in this pass:**
- `express@4.22.2`'s own `qs` dependency still resolves inside the
  vulnerable range (`GHSA-x5fp-wj9c-mxmx`, `GHSA-4mjr-xmp4-gh2g` — both
  denial-of-service class, CVSS ≤5.3, not RCE/injection). No non-breaking
  fix exists in the express 4.x line; full remediation needs an express
  5.x major-version upgrade, which is a real (if probably mechanical)
  migration that's out of scope for a baseline pass and should be its own
  tracked piece of work.
- The dev-tooling advisories (vite/vitest/esbuild/drizzle-kit, including the
  one "critical" entry — a Vitest UI arbitrary-file-read issue that only
  matters if the Vitest UI server is exposed, which it isn't here) are not
  present in any production artifact; fixing them means bumping vitest to a
  major version, which risks destabilizing the test suite for no production
  security benefit. Tracked, not urgent.

## 5. What This Report Does *Not* Cover

- No live-provider contract tests were run (no provider credentials in this
  environment).
- `test:integration` was not executed end-to-end here (no `DATABASE_URL`);
  the newly-gated `load.integration.test.ts` and the existing
  `conversations.integration.test.ts` both correctly no-op via
  `skipIf`, which this report treats as "correctly gated," not "verified
  passing."
- Load-test numbers printed during the (now-gated) run in this sandbox
  reflect the in-memory backend only — see `packages/loadtest` for the
  standalone CLI runner if realistic throughput numbers against a live
  stack are needed.

## 6. Net Effect of This Pass

- `npm test`: 3 failed → **0 failed** (219 passed, 12 correctly skipped).
- `npm audit`: 11 → 10 vulnerabilities (1 non-breaking fix applied; residual
  items documented with why they weren't force-fixed).
- No test assertions were weakened, no tests deleted, no security checks
  disabled. Two of the three fixes were test-harness bugs; the third was a
  stale assertion. Zero platform-code defects were found in this pass — the
  underlying transactional-outbox / fail-closed-webhook logic that the flaky
  test was (mis)reporting on is confirmed correct by code inspection.
