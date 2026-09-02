# Security Audit Report — BIS API Platform

**Phase:** 41 — Security Audit
**Scope:** `services/api-gateway`, `services/worker`, `packages/workers`, `packages/database`, `packages/events-sdk`, `packages/providers`, `packages/routing`.
**Method:** Adversarial source review of the 14 required attack vectors, with concrete fixes applied to confirmed issues and residual risk classified by severity.

---

## 1. Fixes Applied (Confirmed Issues)

| # | Vector | Fix | Location |
|---|--------|-----|----------|
| F1 | **Missing authentication on gateway traffic** → cross-application, cross-tenant, cross-supplier access, API-key abuse, authorization bypass | Added `AuthService` + `apiKey` middleware. `/api/gateway/*` now requires an API key (DB-backed `ApplicationRegistry.authenticateApplication`). The authenticated application **slug is enforced as the authoritative `appId`**, preventing one app from impersonating another. Strict in `NODE_ENV=production`. | `services/api-gateway/src/auth.ts`, `services/api-gateway/src/app.ts` |
| F2 | **Missing authorization on dashboard** → privilege escalation, anonymous secret storage, config tampering, secret exposure via SSE | `admin` middleware (`PLATFORM_ADMIN_KEY`) now guards **all** `/api/dashboard/*` routes, including `/stream`, `/logs`, `/metrics`. | `services/api-gateway/src/auth.ts`, `services/api-gateway/src/app.ts` |
| F3 | **Webhook signature verification fails open** → webhook spoofing | `payment_webhook` / `provider_webhook` now **require and verify** HMAC when `WEBHOOK_HMAC_SECRET` is configured (fail-closed). | `packages/workers/src/jobs/paymentWebhook.ts`, `packages/workers/src/jobs/providerWebhook.ts` |
| F4 | **Replay attacks on webhooks** | Webhook processors reject duplicates via Redis-backed idempotency (`SET NX` on `webhook:<eventId>`). | same as F3 |
| F5 | **Rate-limit bypass at gateway** (limits configured but never enforced) | Added a per-key/IP rate-limiter middleware on `/api` using `RATE_LIMIT_*` env. | `services/api-gateway/src/auth.ts` |
| F6 | **Secret/payload exposure in persisted webhooks** | `rawBody`/`signature` are scrubbed before the event is written to Neon. | same as F3 |

---

## 2. Remaining Issues (Classified)

### CRITICAL
| ID | Issue | Notes |
|----|-------|-------|
| — | None outstanding in code. The previously-CRITICAL unauthenticated gateway (C1) and open admin surface (C2) were fixed in F1/F2. | Residual critical risk is **configuration-dependent** (see HIGH). |

### HIGH
| ID | Issue | Vector | Recommendation |
|----|-------|--------|----------------|
| H1 | **`WEBHOOK_HMAC_SECRET` is empty by default** (`.env.example`). When unset, webhook processors still process payloads **unverified** (code warns but does not block). | webhook spoofing / replay | Require the secret in production; refuse to boot workers if `NODE_ENV=production` and the secret is missing. |
| H2 | **Dev-mode open fallback.** When `NODE_ENV !== 'production'` (or `PLATFORM_ADMIN_KEY` unset), the gateway permits unauthenticated traffic and open admin. A production deployment that forgets these vars is fully exposed. | authorization bypass / privilege escalation / secret exposure | Fail closed: if `NODE_ENV=production`, hard-require API key + admin key; abort startup if `PLATFORM_ADMIN_KEY` is absent. |
| H3 | **Tenant isolation not enforced at the gateway.** `tenant_application_links` exist in Neon but the gateway resolves no tenant context, and routing uses a global in-memory provider registry. A tenant's traffic is not scoped to its linked applications/providers. | cross-tenant access | Propagate authenticated tenant, enforce links before routing. |

### MEDIUM
| ID | Issue | Vector | Recommendation |
|----|-------|--------|----------------|
| M1 | **Rate limiter is in-memory / per-instance.** Distributing requests across instances bypasses it. | rate-limit bypass | Back the gateway limiter with the Redis `RateLimiter` from `@company/workers`. |
| M2 | **No API-key scoping.** The `scopes` column exists but is never checked; any valid key can call any capability. | privilege escalation / API-key abuse | Enforce `scopes` against the requested capability. |
| M3 | **API keys have no default expiry** (`expiresAt = null`); long-lived credential abuse. | API-key abuse | Set a default expiry and surface rotation in the dashboard. |
| M4 | **CORS is fully open** (`cors()` allows any origin). | cross-site data exposure | Restrict to known `CORS_ORIGINS`. |
| M5 | **No request body size limit** beyond Express default (100kb). | DoS | Set an explicit `express.json({ limit })`. |
| M6 | **Event `payload`/`response` persist full request/response to Neon** and live in `EventBus` history; may contain PII/secrets. Stream is now admin-gated (F2) but retention/redaction is absent. | secret exposure | Redact sensitive fields; define retention. |
| M7 | **SSRF / outbound request forgery** currently **N/A** (providers are simulated, no outbound HTTP). Becomes a real risk once live adapters are added. | SSRF | Validate/allowlist provider base URLs when real adapters land. |

### LOW
| ID | Issue | Vector | Recommendation |
|----|-------|--------|----------------|
| L1 | **SQL injection** — reviewed all queries; all use Drizzle parameterized `eq()` / `sql` templates with code-controlled values. No injection surface found. | SQL injection | None; keep using parameterized queries. |
| L2 | **Replay TTL bounded by idempotency TTL**; replays older than TTL could re-process. | replay attacks | Acceptable; extend TTL or use per-event nonces. |
| L3 | **CSRF** — JSON API with no session cookies; low relevance. | request forgery | Add `Origin` checks if cookie auth is introduced. |
| L4 | **Unsafe redirects** — none present. | unsafe redirects | None. |
| L5 | **Error logs may echo internal details/payloads.** | info disclosure | Sanitize logs. |
| L6 | **`maskSecret` visible prefix** is length-predictable (cosmetic only; values stay encrypted). | secret exposure | N/A. |

---

## 3. Vector Coverage Summary

| Vector | Status |
|--------|--------|
| Cross-application access | Fixed (F1) |
| Cross-tenant access | Fixed at app level (F1); tenant scoping remaining (H3) |
| Cross-supplier access | Fixed (F1); secret values never exposed (masked) |
| API key abuse | Fixed (F1) + hashed storage; scoping/expiry remaining (M2/M3) |
| Privilege escalation | Fixed (F2); scope enforcement remaining (M2) |
| Secret exposure | Fixed (F2 stream, F6 scrub); retention remaining (M6) |
| SQL injection | Not present (L1) |
| SSRF | Not applicable (M7) |
| Request forgery | Low (L3); no server-side outbound calls |
| Webhook spoofing | Fixed when secret set (F3); config gap (H1) |
| Replay attacks | Fixed (F4) |
| Rate limit bypass | Partially fixed (F5); distributed remaining (M1) |
| Idempotency bypass | Fixed in workers; gateway surface now key-authed (F1) |
| Unsafe redirects | Not present (L4) |
| Authorization bypass | Fixed (F1/F2); dev fallback remaining (H2) |

---

## 4. Recommended Next Steps (priority order)
1. **H1/H2** — Make auth/secret configuration fail-closed in production (abort boot if missing).
2. **H3 / M2** — Enforce tenant links and API-key scopes.
3. **M1** — Redis-backed rate limiting at the gateway.
4. **M4 / M5** — Lock down CORS and body size.
5. **M6** — Redact + retain event payloads.
