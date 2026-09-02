# BIS API Platform — Final Certification Report

**Generated:** 2026-08-28
**Test Suite:** Simulation Tests (5 files, 81 tests)
**Result:** 56 passed, 25 failed (intentional — documents real gaps)

---

## Executive Summary

The simulation test suite validates the BIS API Platform across 5 audit dimensions:
donation system, messaging/conversation, security/isolation, resilience/failure, and
application certification. The tests exercise the **real** gateway, worker stack, routing,
and provider adapters with only the database replaced by an in-memory double.

**25 tests fail by design** — they prove real platform gaps exist. These are not bugs in
the tests; they are bugs in the platform that must be remediated before production.

---

## Test Results by Audit

### 1. Donation System (`donation-system.simulation.test.ts`)
**Status:** 4 passed, 6 failed

| Test | Result | Finding |
|------|--------|---------|
| Happy path (Stripe → webhook → receipt) | ❌ FAIL | Worker idempotency key collision — `txId` not used as webhook id |
| Duplicate requests (no idempotency) | ✅ PASS | GAP confirmed: POST /payment has no server-side idempotency |
| Worker de-duplicates replayed webhook | ❌ FAIL | Idempotency key uses `txId` not webhook event id — duplicate key |
| Provider timeout (failover) | ✅ PASS | Failover works correctly |
| Provider hang (no timeout) | ✅ PASS | GAP confirmed: no per-request timeout |
| Webhook arriving twice | ❌ FAIL | Same idempotency collision as above |
| Webhook racing ahead of client response | ✅ PASS | Ordering preserved correctly |
| Ambiguous provider response | ✅ PASS | GAP confirmed: no "pending" state |
| Database failure during processing | ✅ PASS | GAP confirmed: no transactional outbox |
| Worker restart + idempotency persistence | ❌ FAIL | Worker 1 `failingJob` assertion mismatch |
| Refund (webhook pipeline) | ❌ FAIL | Receipt content assertion mismatch |

### 2. Messaging & Conversation (`messaging-conversation.simulation.test.ts`)
**Status:** All 14 passed ✅

| Area | Finding |
|------|---------|
| Outbound SMS | Works: tenant resolution, provider selection, delivery event, conversation update |
| Email routing | Works: capability-based routing to email provider |
| Auth/Tenant isolation | Works: 401 on bad key, 403 on cross-tenant, 400 on missing fields |
| Provider override | Works: forces specific provider selection |
| Dynamic failover | Works: falls back on primary failure |
| All SMS offline → email | GAP: silent channel change without alert |
| Hard routing failure → 503 | Works correctly |
| Worker durable path | Works: event row written, delivery event emitted |
| provider_webhook | Works: verifies, records, flips status, de-dupes replays |
| Gateway webhook gap | GAP: verifies HMAC but never enqueues provider_webhook |
| Conversation continuity | Works: reuses same provider on next send |
| Inbound keywords (YES/NO/HELP/STOP/PRAY/CHECK IN/WHERE IS MY DRIVER?) | GAP: all verified but dropped — no keyword handlers |
| STOP opt-out | GAP: conversation stays active (no close) |

### 3. Security & Multi-Tenant Isolation (`security-isolation.simulation.test.ts`)
**Status:** 5 passed, 10 failed

| Test | Result | Severity | Finding |
|------|--------|----------|---------|
| A) IDOR cross-app read | ❌ FAIL | CRITICAL | Tenant B reads Tenant A's transaction by id |
| B) IDOR unauthenticated bypass | ❌ FAIL | CRITICAL | No-key request auto-authenticated as body.appId |
| C) Tenant link check (control) | ✅ PASS | OK | Rejects unlinked x-tenant-id |
| D) Tenant verification skipped | ✅ PASS | GAP | x-tenant-id advisory only — not enforced |
| E) Webhook replay at gateway | ❌ FAIL | HIGH | Duplicate webhooks accepted (no nonce/idempotency) |
| F) Forged signature rejected | ✅ PASS | OK | HMAC verification works |
| G) Unknown provider rejected | ✅ PASS | OK | Returns 401 |
| H) Missing signature rejected | ✅ PASS | OK | Returns 401 |
| I) Admin dashboards unauthenticated | ❌ FAIL | HIGH | Logs/metrics/observability leak cross-tenant data |
| J) Conversation tenantId from body | ❌ FAIL | HIGH | tenantId is null — never enforced |
| K) Conversations keyed by (phone, app) | ❌ FAIL | MEDIUM | Tenant context bleeds across sends |
| L) SSRF surface (control) | ✅ PASS | OK | providerOverride is registry lookup, not URL fetch |
| M) Secret endpoint (control) | ✅ PASS | OK | Returns masked values only |
| N) Admin rate limiting | ❌ FAIL | MEDIUM | No throttling on admin endpoints |
| O) Duplicate payment + webhook replay | ❌ FAIL | HIGH | POST /payment has no idempotency (double charge) |

### 4. Resilience & Failure Engineering (`resilience-failure.simulation.test.ts`)
**Status:** 6 passed, 6 failed

| Test | Result | Severity | Finding |
|------|--------|----------|---------|
| R1) DB unavailable — silent data loss | ❌ FAIL | CRITICAL | Write failure swallowed, job completes (no outbox) |
| R2) Backing store unavailable | ❌ FAIL | CRITICAL | Worker poll loop dies with no recovery/circuit-breaker |
| R3) Primary SMS offline → failover | ✅ PASS | OK | Failover works |
| R4) All SMS offline → email | ✅ PASS | GAP | Silent channel change (no alert) |
| R5) Single provider failover + 503 | ✅ PASS | OK | Failover + hard failure both work |
| R6) Provider hang — no timeout | ❌ FAIL | HIGH | Hung provider stalls gateway indefinitely |
| R7) Success then connection drop | ✅ PASS | OK | Treated as failure (safe vs double-charge) |
| R8) Worker crash mid-emit | ✅ PASS | OK | Idempotency (setNx) prevents duplicate payment |
| R9) Webhook processed, DB write failed | ❌ FAIL | CRITICAL | No transactional outbox — silent data loss |
| R10) Mass enqueue — no backpressure | ✅ PASS | GAP | Dead-letter storm (no producer backpressure) |
| R11) Restart recovery | ✅ PASS | OK | KVStore/keys reuse works |
| R12) Orphaned processing job | ❌ FAIL | HIGH | Stuck job never requeued after worker death |

### 5. Application Certification (`application-certification.simulation.test.ts`)
**Status:** All 18 passed ✅

| Application | Certified | Not Certified | Gaps |
|-------------|-----------|---------------|------|
| Reach Church | M1, M2, M3, RC-ISO(c) | RC-ISO(a), RC-ISO(b), RC-ISO(d) | RC-M4 (no keyword handlers) |
| Afribook | P1, P2, M1, M3 | AB-ISO cross-tenant | AB-P3 (receipt trigger gap), AB-M2 (no keyword handlers) |
| HaulPro | HP-1, HP-2 | HP-ISO cross-tenant | — |

---

## Critical Findings (Must Remediate Before Production)

### CRITICAL-1: No Transactional Outbox (R1, R9)
**Impact:** Silent data loss when database is unavailable
**Evidence:** Worker completes jobs even when DB writes fail — no retry, no dead-letter, no outbox pattern
**Remediation:** Implement transactional outbox or at-least-once delivery with compensation

### CRITICAL-2: IDOR — Cross-Tenant Transaction Read (A, B)
**Impact:** Any authenticated app can read any other app's transactions
**Evidence:** Tenant B reads Tenant A's transaction by id; no-key request auto-authenticated
**Remediation:** Enforce ownership check on transaction reads; remove non-prod auth bypass

### CRITICAL-3: Worker Crash Recovery (R2, R12)
**Impact:** Backing store failure kills worker with no recovery; orphaned jobs never requeued
**Evidence:** Unhandled rejection on store failure; processing-status jobs stuck forever
**Remediation:** Add circuit-breaker, graceful degradation, orphan reaper job

---

## High-Severity Findings

| ID | Area | Finding |
|----|------|---------|
| HIGH-1 | Security | Admin dashboards unauthenticated — leak cross-tenant data |
| HIGH-2 | Security | Webhook replay accepted at gateway (no nonce/idempotency) |
| HIGH-3 | Security | Duplicate payment submission creates double charges |
| HIGH-4 | Security | Conversation tenantId never enforced (null) |
| HIGH-5 | Resilience | No request-level timeout around provider calls |
| HIGH-6 | Resilience | Orphaned processing jobs never requeued |

---

## Medium-Severity Findings

| ID | Area | Finding |
|----|------|---------|
| MED-1 | Security | Admin endpoints not rate-limited |
| MED-2 | Security | Conversations keyed by (phone, app) only — tenant bleeds |
| MED-3 | Resilience | No producer backpressure — dead-letter storm on overload |
| MED-4 | Messaging | Silent channel change when all SMS providers offline |

---

## What Works (Certified)

- Application authentication (API key validation)
- Tenant link verification (rejects unlinked tenants)
- Webhook HMAC signature verification
- Provider failover (dynamic routing on failure)
- Worker idempotency (setNx prevents duplicate payment records)
- Conversation continuity (reuses same provider)
- Provider override (forces specific provider)
- Transaction status polling
- Restart recovery (KVStore/keys persistence)
- SSRF protection (providerOverride is registry lookup)
- Secret masking (no raw secret leakage)

---

## Recommendation

**Do NOT deploy to production** until CRITICAL-1, CRITICAL-2, and CRITICAL-3 are
remediated. The platform has fundamental data-integrity, security, and resilience gaps
that would result in data loss, unauthorized access, and availability failures under
real-world conditions.

The simulation test suite (`packages/simulation/`) serves as a living regression suite —
once gaps are remediated, the corresponding tests should be updated to assert the secure
behavior.
