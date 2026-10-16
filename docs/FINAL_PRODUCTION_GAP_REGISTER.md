# BIS API Platform — Final Production Gap Register

**Status:** Phase 0 inventory COMPLETE (6 of 6 areas reported). Phase 1 (baseline command execution/re-verification) not yet formally run by the certifying session itself — see Section F for baseline numbers already captured by the CI/CD inventory agent as a byproduct of its investigation; these must be independently re-confirmed in Phase 1 per the anti-fabrication rule before being relied upon.
**Scope basis:** read-only code inspection of `claude/bis-api-platform-main-reconciliation` @ `d8840c0`. Code is treated as the sole source of truth; any prior report or doc claim is treated as an unverified assertion until contradicted or confirmed against the current code.
**Rule in force for this entire document:** nothing is marked PASS/FIXED without executable evidence. Nothing is marked PRODUCTION READY while a P0 is open. Anything that cannot be verified due to missing credentials/external infra is marked `BLOCKED — EXTERNAL VERIFICATION REQUIRED`, never PASS.

**Severity key:** P0 = cross-tenant data leak, double-charge, silent data loss, or auth bypass. P1 = correctness bug with a real but bounded blast radius. P2 = missing defense-in-depth / design weakness. P3 = minor / code-quality. Info = observation, not a defect.

---

## Inventory coverage status

| Area | Status | Agent |
|---|---|---|
| Routing / messaging / shared-phone-number conversation resolver | **Done** | `adf1b846d44f8b8c0` |
| Workers / queue infrastructure | **Done** | `a903c9f5a26890413` |
| Database layer (schema, migrations, repositories, idempotency, outbox, secrets) | **Done** | `ade385fcac001bf20` |
| API gateway (`services/api-gateway/src/app.ts`, auth, admin, SSE, health) | **Done** | `ad502fd0fc80c1b40` |
| Provider adapters (14 payment + 11 messaging) | **Done** | `a44c91f0b4528208b` |
| CI/CD, deployment config, test inventory, prior-doc claims | **Done** | `a20c4e9dcd3a1a5a5` |

This document will be appended, not rewritten, as each remaining area reports back.

---

## SECTION A — Routing, messaging, shared-phone-number conversation resolution

**Reviewed:** `packages/routing/src/{index,conversation-resolver,conversation,keywords,rules,scoring}.ts`, `packages/database/src/schema/{conversations,consent-records,messaging-profiles}.ts`, `packages/database/src/repositories/{conversations,consent-records}.ts`, `packages/workers/src/jobs/inboundMessage.ts`, `packages/providers/src/{registry,base}.ts`, `packages/providers/src/adapters/payments/stripe.ts` (+ grep across other payment adapters), relevant routes in `services/api-gateway/src/app.ts`, `packages/simulation/src/messaging-conversation.simulation.test.ts`, `packages/routing/src/routing.test.ts`.

### Bottom line

The platform's shared-phone-number requirement is **not met**. `ConversationResolver` cannot distinguish tenants sharing a number. When it cannot decide, it still returns the most recently active tenant's conversation, and the worker routes the message — including STOP, YES, NO — to that guessed tenant. There is also a cross-provider double-charge path: all 14 payment adapters flatten network errors/internal aborts/5xx into `status:'failed'`, and the routing engine retries `'failed'` on a different provider.

### A1. Conversation schema — no sender/destination-number column — **FIXED, Phase 8**

- **Original defect:** unique key was `(phone_number, app_id, tenant_id)`, with `phone_number` always the customer's number — nothing recorded which shared business number the conversation was actually on.
- **Fix:** migration `0017_conversation_ownership_shared_numbers.sql` adds `business_number`, `supplier_id`, `messaging_profile_id` (FK, `ON DELETE SET NULL`), `country`, and a placeholder `workflow_id` to `conversations`. The unique key is replaced with `uq_conversations_owner UNIQUE NULLS NOT DISTINCT (phone_number, business_number, app_id, tenant_id, supplier_id)` — deliberately using Postgres 15+'s `NULLS NOT DISTINCT` so the same customer can correctly hold simultaneous, separate conversations with different tenants on the same shared number, two businesses of one tenant on the same number (STAYSCAPE-style), or one tenant across two different numbers. Provider and channel are deliberately excluded from the key so a provider failover doesn't fracture a conversation in two. Existing rows' `business_number` is left NULL rather than guessed — an honest, non-destructive migration choice.
- **Test proving remediation:** `conversation-ownership.postgres.integration.test.ts` (10 tests, real Postgres) proves the 0016→0017 upgrade works on existing data, the unique key is genuinely enforced by Postgres, and 20 concurrent upserts of the same owner produce exactly one row. Independently re-run by the orchestrating session: the exact `UNIQUE NULLS NOT DISTINCT` constraint spot-checked directly in the migration SQL.
- **Status:** **FIXED**

### A2. `ConversationResolver` destination-number check is dead code — **FIXED, Phase 8**

- **Original defect:** the resolver's disambiguation compared the candidate's own (customer) phone number against the recipient phone — a comparison that could never match in practice, and the only caller never even passed `appId`/`tenantId`.
- **Fix:** `ConversationResolver` is rewritten to implement the actual inbound routing chain the spec requires: provider → destination number → `messaging_profiles` owners (app, tenant, supplier) → the customer's conversations on that specific number → distinct owners. The previously-unused `messaging_profiles` table (which already mapped sender numbers to app/tenant) is now genuinely read on the inbound path for the first time. Conversations that predate this phase (no recorded business number) count only toward owners actually registered on the destination number, not toward every tenant indiscriminately.
- **Test proving remediation:** `conversation-resolver.test.ts` (15 tests) plus the end-to-end shared-number scenario suite below.
- **Status:** **FIXED**

### A3. Ambiguous resolution still returns a guessed conversation, and the caller acts on it — **FIXED, Phase 8**

- **Original defect:** `confidence:'ambiguous'` was returned together with a non-null, most-recently-active guessed conversation; the worker only special-cased `'none'`, so ambiguity fell through to full processing — persisting content, running STOP/YES/NO, emitting events — all under the wrong, guessed tenant.
- **Fix:** the resolver's return type is now a tagged union (`kind: 'routed' | 'ambiguous' | 'unroutable'`) rather than a single shape with an optional guessed conversation — engineered so that accessing message-delivery fields without first narrowing the `kind` is a **TypeScript compile error**, not just a documented convention (enforced further by `@ts-expect-error` assertions in the test file). On true ambiguity or unroutability, `inboundMessage.ts` now writes no tenant event, runs no keyword handler, changes no tenant's consent, and emits no tenant-addressed event carrying message content — instead emitting a platform-level signal with no content and no tenant, and durably holding the message (`inbound_message_holds`, a new quarantine table with CHECK constraints, deduplicated on the durable webhook event id from Phase 4) for operator attribution via new admin routes (`GET /api/dashboard/inbound-holds`, `POST /:id/resolve` — accepting only an owner the platform itself recorded as a genuine candidate, 409 otherwise — and `POST /:id/discard`).
- **Concrete scenarios now proven fixed, each independently re-run by the orchestrating session:**
  1. **Content leak (the Reach Church/HaulPro prayer-request scenario):** `shared-number.simulation.test.ts` + `shared-number.postgres.integration.test.ts` (19 scenarios each, run through the real gateway HTTP routes, real durable webhook intake, and real inbound worker) prove a message now reaches Reach Church correctly even though HaulPro messaged the shared number more recently — the previous recency-based guess is gone.
  2. **Genuine ambiguity (no destination-number data can disambiguate):** proven held, with nothing delivered to any tenant; a redelivered webhook creates no duplicate hold (ties correctly into Phase 4's durable identity); YES/NO is applied to no one; an operator can resolve only to a genuinely recorded candidate.
  3. **YES/NO mis-confirmation (the STAYSCAPE two-hotels scenario):** proven that a YES confirms neither hotel's booking until an operator explicitly attributes it.
  4. **The "single candidate" fast path:** confirmed it no longer silently guesses either — it is now only taken when the destination-number chain genuinely identifies one unambiguous owner.
  5. **The single-tenant case (regression check):** proven to still route normally and promptly — the common case was not broken while fixing the rare one.
- **Negative control, performed by the implementing agent:** the original resolver and worker were temporarily restored and the full shared-number scenario suite re-run — **16 of 19 scenarios failed on both the in-memory and real-Postgres runs**, reproducing the exact documented defects (e.g. "expected 'haulpro' to be 'reach-church'" for the prayer-request leak; "expected 'opted_out' to be undefined" for the wrong-tenant STOP). Both files were then restored to the fixed version.
- **Test coverage:** was previously **none** for any multi-tenant scenario; now 19 adversarial scenarios run against two separate databases (in-memory and real Postgres) through the real HTTP/worker pipeline, plus 15 resolver unit tests.
- **Status:** **FIXED** — this closes the platform's own explicitly-named critical requirement violation ("If multiple possible contexts exist: DO NOT GUESS... Never route an inbound message to another tenant because its conversation is newer"), independently verified with a negative control that reproduces the exact original defect on demand.

### A4. Per-tenant STOP conflicts with carrier-level STOP on a shared sender number — **FIXED, Phase 8**

- **Original defect:** opt-out was recorded scoped to `(appId, tenantId, recipient, channel)`, not the shared sender number, conflicting with real carrier behavior (Twilio Advanced Opt-Out and similar block STOP at the number level, affecting every tenant on that number regardless of platform-side tenant attribution).
- **Fix:** a new `sender_opt_outs` table records STOP against the shared `business_number` itself, independent of any tenant — matching real carrier semantics exactly ("send nothing from number S to this customer"), so it can never land on the wrong tenant and never vanishes during ambiguity. Outbound sends from an opted-out number are refused with 403, and the router does not fail over around a STOP. The sender-level consent check fails *closed* (aborts the send) if the lookup itself errors — the inverse of the previously-open A7 finding, applied specifically to this new mechanism. An unambiguous STOP on a number registered to more than one owner in `messaging_profiles` also records the number-level block as a mirror of the tenant-level one. START during ambiguity correctly clears only the number-level block.
- **Test proving remediation:** the shared-number scenario suite's STOP-during-ambiguity case proves no tenant's own consent record changes, the number-level opt-out is recorded, and both tenants' sends correctly get 403; `sender-consent.test.ts` (5 tests) covers the mechanism directly.
- **Honest residual, disclosed by the implementing agent:** the number-level block alone doesn't prevent a candidate tenant from reaching the customer via a *different* number or channel between an ambiguous STOP and an operator's eventual attribution — flagged as a known gap, not claimed as airtight.
- **Status:** **FIXED** (for the shared-number case this finding specifically describes; the cross-channel residual is tracked as a new known-gap item, not a separate register finding, since it's an inherent limitation of number-scoped blocking rather than a bug).

### A5. STOP opt-out write failures are silently swallowed — **FIXED, Phase 8**

- **Original defect:** a failed consent-record upsert was swallowed by an empty `catch {}`, and the customer was still told "You have been unsubscribed" while the opt-out was actually lost.
- **Fix:** a failed STOP/JOIN consent write now throws, causing the job to retry rather than falsely confirming success to the customer.
- **Status:** **FIXED**

### A6. Consent channel is hardcoded / inferred from content, not the real channel — **FIXED (send path), Phase 10**

- **Original defect:** an SMS body over 300 characters or containing `wa:` was silently sent as WhatsApp and checked against WhatsApp consent instead of SMS consent.
- **Fix:** `MessageRequest.channel` is now a real, explicit field (`'sms' | 'whatsapp' | 'email'`); an explicit value always wins over content-based inference, and every event records `requestedChannelSource: 'explicit' | 'inferred'` so it's visible which path decided. Content-based inference (the old length/`wa:`-substring heuristic) is preserved only as the last-resort default when no channel is specified at all — not removed, since existing callers that never specified a channel must keep working, but it can no longer silently override an explicit request. An invalid channel, or an explicit channel that doesn't fit the recipient address (e.g. an email channel with a phone number), is now a 400, not a guess.
- **Status:** **FIXED** for the outbound/send path described here. **The inbound half (STOP arriving over WhatsApp still defaulting to an `sms` opt-out) was explicitly out of scope for Phase 10 and remains OPEN** — tracked below as a residual.

### A7. Consent check fails open on DB error

- **File/Line:** `routing/src/index.ts`, consent lookup `catch` block: `console.error(...failing open (send proceeds)...)`
- **Severity:** P1
- **Status:** OPEN — confirmed still open; Phase 10's new channel-fallback consent check (for an opted-in cross-channel send specifically) does fail *closed*, but the original send-path consent check this finding describes is unchanged.

### A8. Capability/health gates are bypassed by override, rule-target, and hardcoded fallback pools — **FIXED, Phase 10 (messaging half) + Phase 11-12 (payments half)**

- **Original defect (messaging half):** `activeMsg[0]`/`activeMsg.find(...)` picked ANY available messaging provider regardless of channel, and conversation continuity made a fallback silent and permanent.
- **Fix (messaging half, Phase 10):** the any-channel last-resort pool is gone entirely. Provider override, conversation continuity, rule targets, scored selection, and failover now all only consider providers that actually support the channel being sent on; conversation continuity specifically now only reuses a thread on the *same* channel, so a fallback can never become permanent — each new message re-evaluates its own requested channel independently.
- **Test proving remediation (messaging half):** see A9 below (same test suite covers both). Negative control: reintroducing the old any-channel pool made 10 tests fail, including one where the event itself falsely reported `selectedChannel:'sms'` while the provider actually used was WhatsApp — a concrete reproduction of exactly the silent-mislabeling risk this finding describes.
- **Original defect (payments half):** `providerOverride` and routing-rule targets checked only availability/live-eligibility, not capability/currency/country; a hardcoded fallback pool (`['stripe','nmi','airwallex']`) was used whenever no genuinely capable provider existed, risking e.g. an MWK mobile-money payment being silently routed to Stripe as a card charge.
- **Fix (payments half, Phase 11-12):** override, routing-rule target, scored selection, and the failover cascade now all choose only from providers that actually support the requested capability/currency/country (reusing the registry's own `findByCategoryAndCapabilities` logic, rather than a separate, weaker check). The hardcoded fallback pool is removed entirely — with no genuinely capable provider, the request now fails closed with a new `PaymentRouteUnavailableError`, surfaced by the gateway as `503 payment_route_unavailable`, rather than silently routing through an incapable provider. **Deliberate design decision, documented by the implementing agent:** an explicit `providerOverride` naming a specific provider does *not* bypass these checks — if the named provider genuinely can't handle the payment's currency/country, the request is rejected with `422 provider_override_incapable` rather than silently substituted or forced through anyway, since the payment token itself is provider-specific and charging it through a different provider than the one it was created for cannot be what the caller meant. An override naming a provider that is merely temporarily *offline* (not incapable) still correctly falls back to another capable provider, preserving an existing test's required behavior for that narrower, legitimate case.
- **Test proving remediation (payments half):** `payment-capability-routing.test.ts` (11 tests) proves an override naming an incapable provider is rejected (422), a routing rule whose target can't handle the payment is skipped with the reason recorded in `decisionReason`, and that with no capable provider anywhere, the response is the new specific `503` rather than a silent route through the old hardcoded pool. Negative control: reintroducing the old override/rule bypass plus the `['stripe','nmi','airwallex']` pool broke 10 tests.
- **Status:** **FIXED** in full — both halves closed.

### A9. Silent channel switching — `allowChannelSwitch` policy flag never read — **FIXED, Phase 10**

- **Original defect:** `allowChannelSwitch`/`requiresConsent` were defined but never consulted; only `allowAlternateProvider` was checked. No `requested_channel`/`selected_channel`/`fallback_reason` fields existed anywhere.
- **Fix:** `allowChannelSwitch` is now genuinely enforced, configured per-request via a `channelPolicy` field (deliberately per-request rather than per-tenant — reasoning: whether a different channel beats no message at all depends on the specific message, e.g. an OTP should never silently switch channels while an appointment reminder reasonably might; a tenant-wide default would just reintroduce silent switching for any caller who didn't think to set it; and the opt-in traveling on the request/event payload keeps it auditable per-send rather than hidden in config). When `channelPolicy.allowChannelSwitch` is false (the default), a requested channel with no available provider now fails with `503 channel_unavailable` and a specific detail message — never a silent substitution. When explicitly opted in, a cross-channel fallback is only used if a real address exists for that channel (a phone number is never silently "emailed") and the recipient has an actual `opted_in` consent record on the fallback channel specifically, with that consent check failing *closed*. `requestedChannel`, `requestedChannelSource`, `selectedChannel`, and `fallbackReason` are now real fields on every messaging event (success or failure), visible in the API response body, the emitted event (SSE and tenant webhooks per Phase 7's tenant-scoping), and the 503 failure body — never only free-text in `decisionReason`. A new migration adds these three columns to `events` with a **database CHECK constraint that makes a silently-unexplained channel change a constraint violation**, not just a code-review convention: `fallback_reason` must be NULL when the channel didn't change, and must be a real, non-blank reason when it did.
- **Test proving remediation:** `channel-fallback.simulation.test.ts` (13 tests) proves all four required scenarios: (1) SMS down with no opt-in gets a specific failure with zero calls to any other channel's provider; (2) an opted-in fallback is fully visible in both the HTTP response and the bus event with the exact requested/selected/reason fields; (3) a fallback is never sticky — the next message, explicit or inferred, correctly uses the original channel again once it's available; (4) content-based inference still works as a last-resort default but never overrides an explicit request. `channel-policy.test.ts` (11 unit tests) and `channel-fallback.postgres.integration.test.ts` (5 tests, real Postgres, including a clean upgrade from an existing 0018 database with pre-existing rows) extend coverage. Negative controls, each independently reverted and restored (SHA-256 verified): unscoped conversation continuity (3 failures), the any-channel last resort (10 failures, including the false-labeling case above), ignoring `allowChannelSwitch`/consent (8 failures), and inference overriding an explicit channel (4 failures). Independently re-run by the orchestrating session: full suite 864/1030 passing, 0 failed, confirmed directly; the `chk_events_channel_fallback_reason` CHECK constraint and the `channel_unavailable` error code spot-checked directly in source; confirmed the old `activeMsg[0]`/`activeMsg.find()` any-channel pool no longer exists in `routeMessage`.
- **Status:** **FIXED**

### A10. Cross-provider double-charge path via flattened failure classification — **FIXED, Phase 11-12**

- **Original defect:** every payment adapter's catch block mapped network errors, internal `AbortError` timeouts, and HTTP 5xx into `status:'failed'`, which the router retried on a different provider — a real double-charge risk whenever the first provider had actually processed the charge before the response was lost.
- **Fix:** every adapter's error handling now distinguishes two cases explicitly, documented per-adapter based on each provider's real, documented API semantics: a **definite decline** (the provider's response was received and is unambiguous — e.g. a clean card-declined response, a validation error that fires before any charge attempt) is still `'failed'` and still safely retried elsewhere; a **genuinely ambiguous outcome** (any 5xx, a timeout, a connection error, or anything that happened after the request may have already been sent) is now classified as `'unknown'` — Phase 6's existing state-machine state — and is **never** retried on a different provider, instead flowing into Phase 6's reconciliation path. An unclassified/unlabeled error defaults to ambiguous (the safe choice) rather than defaulting to a definite decline. A shared `isAmbiguousProviderError` classifier and a new `retryAmbiguous` option on the base HTTP layer also stop several adapters (NMI, Authorize.Net, Braintree, Flutterwave, PayChangu, the Airwallex confirm step, and all refund calls lacking a provider-side idempotency key) from blindly re-sending a possibly-already-processed request internally — only providers confirmed to genuinely replay a result for a repeated idempotency key (Stripe, Adyen, PayPal, Square, Checkout.com, PawaPay) still retry at that layer.
- **Test proving remediation:** `payment-ambiguity.test.ts` (61 tests) proves, per adapter, that a 5xx/connection-reset/timeout becomes `'unknown'` with zero calls to any other provider, while each adapter's own documented decline response still correctly becomes `'failed'` and is still safely retried — both the dangerous case and the legitimate case are independently proven, not just the fix in isolation. `payment-ambiguity.simulation.test.ts` (4 tests) proves the same end-to-end over the real gateway. Negative control: reverting the classification fix broke 48 tests; reverting the no-blind-retry fix broke 21. Independently re-run by the orchestrating session: full suite 946/1113 passing, 0 failed, confirmed directly; the `isAmbiguousProviderError`/`'unknown'` classification path spot-checked directly in `packages/providers/src/base.ts`.
- **Honest, explicitly lowest-confidence disclosures from the implementing agent, preserved here rather than overstated as certain:** the exact classification of several provider-specific error/result codes (Authorize.Net's "processing error" code list, NMI's result codes 420/421/430, Braintree's GraphQL error class names, Adyen code 704, whether Airwallex/PayChangu/Flutterwave replay a result for a repeated idempotency key) is based on the implementing agent's knowledge of each provider's public documentation, **not verified against any live provider account or sandbox** — no credentials existed in this sandbox. These specific adapter-level classification decisions should be prioritized for re-verification in Phase 27 (sandbox provider certification) before being treated as fully certain.
- **Status:** **FIXED**, with the above specific, named exceptions flagged for Phase 27 re-verification rather than silently assumed correct.

**Additional related finding, confirmed still open:** fraud-blocked/hard-declined charges are still retried on another provider/acquirer with no decline-code classification — this was explicitly out of scope for this phase (the implementing agent notes "whether a fraud block should be retried at all" remains an open P1 question, now tracked below as PHASE11-02) and should not be conflated with the ambiguous/definite classification fix above, which addresses a different failure mode.

### A11. Gateway never forwards `paymentToken`/`country`/`idempotencyKey` on the main payment route — Stripe adapter returns simulated success

- **File/Line:** `services/api-gateway/src/app.ts` L706-712 (main gateway payment route), L1773-1778 (checkout route); `packages/providers/src/adapters/payments/stripe.ts` ~L239-241, ~L405
- **Finding:** The gateway's real payment routes construct the provider payload as `{amount, currency, paymentMethod, providerOverride, phoneNumber}` — `paymentToken`, `country`, and `idempotencyKey` are never included. Stripe's adapter: `if (!this.apiKey || !paymentToken) return this.simulatedProcess(...)`, and `simulatedProcess` returns `status:'success'`. Net effect: **a live, correctly-configured Stripe key, called through the platform's own primary payment endpoint, returns a simulated success in production**, because the required token is never forwarded.
- **Severity:** **P0** — this is one of the most severe findings in the entire inventory so far; it means the headline "payments work" claim cannot be true for the real API route as currently wired. This spans gateway + provider adapters and must be cross-confirmed by both re-run inventories before remediation.
- **Status:** OPEN — pending independent confirmation from the gateway and provider-adapter re-run agents.

### A12. No country filtering for messaging; `country` not passed for payments at all

- **File/Line:** `routing/src/index.ts` L362-364 (messaging lookup has no country/currency args); registry seed data shows `signalhouse: countries:['MW']`, `futuresms: countries:['MW','ZM']`, `vibes: countries:['US','CA']`
- **Severity:** P1
- **Risk:** A +1 US SMS can be weighted-random-routed through a Malawi-only gateway and vice versa.
- **Status:** OPEN

### A13. Keyword gaps and tenant-inappropriate auto-responses — **FIXED, Phase 9**

- **Original defect:** CHECK IN and WHERE IS MY DRIVER were not implemented anywhere outside a simulation test that documented them as explicit gaps; PRAY was hardcoded with church-specific wording in the shared platform package and advertised to every tenant via HELP, including HaulPro and Afribook.
- **Fix:** a new `keyword_commands` table (keyed `(app_id, tenant_id)`, with `tenant_id` NULL meaning an app-wide default) lets each application/tenant configure its own command set and reply wording. Universal compliance keywords (STOP/START/HELP/YES/NO) always run first with fixed consent semantics that a tenant cannot override — only their reply *wording* is customizable, enforced both in code and by database CHECK constraints (a HELP reply must still mention STOP; a STOP reply must still mention START; STOP cannot be disabled; no tenant-defined command may collide with an existing compliance keyword). PRAY is no longer built into the shared platform package at all — it is now just one tenant's own configured command, like any other. App-specific "dispatch" commands (CHECK IN, WHERE IS MY DRIVER) produce a durable row in a new `keyword_command_dispatches` table (deduplicated even under webhook redelivery), set `conversations.workflow_id`, and emit a tenant-scoped event the owning application can subscribe to and pull/acknowledge via new gateway routes — the platform never fabricates a business-logic answer (e.g. it has no idea where a driver actually is; it only tells HaulPro's own backend that the question was asked, by the right customer, attributed to the right tenant).
- **New finding discovered and fixed in the same pass:** keyword replies — including HELP and the STOP confirmation — were **never actually being sent to the customer at all**. The `keyword_response_delivery` job existed and was registered, but nothing in the inbound pipeline ever queued it; the inbound worker now enqueues it once per inbound message. This is a independently-significant, previously-undetected defect: no customer has ever received an automated HELP or STOP-confirmation reply from this platform as built. Two related bugs fixed in the same pass: the STOP confirmation reply itself would have been blocked by the very opt-out it was confirming (now carries an internal-only exemption that a request body cannot reach), and a reply to an already-opted-out customer now resolves to a logged no-op rather than retrying forever.
- **START's restore-eligibility design, made explicit and tested:** an explicit STOP requires an explicit re-opt-in to that specific business — START restores only the one tenant it's attributed to (clearing the number-level carrier-style block too, on a shared number), and an ambiguous START (genuine multi-tenant ambiguity) clears only the number-level block and re-subscribes no tenant until an operator attributes it. This was mostly already Phase 8's behavior; Phase 9 pins it with explicit tests, including the case of a customer who had stopped two different tenants sharing one number.
- **Test proving remediation:** `keyword-commands.scenarios.ts` (12 tests, run both in-memory and against real Postgres migrated from zero, using a two-congregation church app, HaulPro, and Afribook) proves per-tenant HELP wording with no cross-tenant leakage of inappropriate language, CHECK IN/WHERE IS MY DRIVER correctly dispatched only to their owning tenant (including a shared-number attribution case and a held-pending-operator-attribution ambiguous case), and the START semantics described above. `keyword-commands.test.ts` adds 36 unit tests. Negative controls: reintroducing the hardcoded PRAY, reverting to a blanket START, and removing the reply-queueing fix each independently broke specific tests (1 and 6 failures respectively), with all files restored and verified byte-for-byte afterward. Independently re-run by the orchestrating session: full suite 840/1001 passing, 0 failed, confirmed directly; the `keyword_commands`/`keyword_command_dispatches` tables and the now-queued `keyword_response_delivery` job spot-checked directly in source.
- **Honest residuals, disclosed by the implementing agent:** held messages (genuine shared-number ambiguity) still get no automatic reply at all, including HELP — this is Phase 8's own deliberate residual #3, unchanged; the audit write for STOP/START remains best-effort by an explicit prior Phase-8 test requirement (the consent and number-level rows are the durable record, not the audit log entry) — flagged as a judgment call for a future phase rather than silently resolved either way; `inbound_message` and the reply-delivery job both remain non-durable jobs (Phase 8's residual #7), though the new dispatch rows themselves are durable and pullable, which does cover the multi-process EventBus gap (PHASE7-01) specifically for app-specific commands.
- **Status:** **FIXED**

### A14. Circuit breaker weaknesses

- **File/Line:** `registry.ts` L86-87, L531-598, L898-923
- **Finding:** half-open state allows unlimited concurrent probe traffic (not exactly-one); `isCircuitAvailable` is a read that mutates state, flipping providers to half-open even when never selected; breaker state is in-process memory only (not shared across gateway/worker instances); only the gateway's final-event `observe()` call feeds failure recording, so providers that failed earlier in a cascade never get a failure recorded against them.
- **Severity:** P2 (each)
- **Status:** OPEN

### A15. Minor/Info findings (routing/messaging)

- Ambiguous-routing monitoring event is mistagged `category:'payment'` (P3).
- ~~`conversationRepository.upsert` is select-then-insert with no `ON CONFLICT`...~~ **FIXED, Phase 8**: the upsert is now a single `ON CONFLICT` statement, removing the race between concurrent first sends (proven by `conversation-ownership.postgres.integration.test.ts`'s 20-concurrent-upserts-produce-one-row case).
- Every provider webhook, including payment webhooks, is queued through the generic inbound-message path rather than being distinguished by type at intake (P3).
- Messaging timeout cascades can deliver duplicate messages (acceptable for cost, not for OTP/transactional sends) (P3).

---

## SECTION B — Workers and queue infrastructure

**Reviewed:** `packages/workers/src/**`, `services/worker/src/index.ts`; cross-checked `services/api-gateway/src/{index,app,auth}.ts`. Four findings were reproduced with throwaway scripts (`tsx`) against the real modules, not just read — see probe table below.

| Probe | Result |
|---|---|
| probe1 | With Redis reachable and answering PONG, `createStore('redis://127.0.0.1:6399')` still returned `MemoryStore` and logged the fallback warning. |
| probe2-A | Two concurrent `promoteDelayed()` calls left the same job id in the ready list twice. |
| probe2-B | A job whose idempotency claim survived a simulated crash was rescued, then marked `completed` with 0 processor runs. |
| probe2-C | At capacity, `enqueue()` correctly threw `QueueBackpressureError`. |
| probe3 | Real `createPaymentWebhookProcessor` with a valid HMAC: attempt 1 failed on a DB error; attempts 2 and 3 failed as "Replay detected"; job ended `dead`. |

### Bottom line

Redis is never actually used by this deployment as currently wired — `createStore()` falls back to in-process `MemoryStore` even when Redis is reachable, which means the gateway and worker are completely partitioned: gateway-enqueued webhook jobs never reach the worker at all. Compounding this, payment and provider webhook processors write their replay-dedup marker *before* doing the work and never clear it on failure, so the very first transient failure (a DB blip, lock contention with a concurrent health check) makes every subsequent retry, crash-rescue, and dead-letter re-drive permanently fail as "replay detected." Both are P0.

### B1. `createStore` always falls back to `MemoryStore` — **FIXED, Phase 4**

- **File/Line:** `packages/workers/src/client.ts` L12-22 (`createStore`); `store.redis.ts` constructor L72, `ping()` L98-101, `assertConnected()` L90-96
- **Evidence:** `this.client.connect().catch(() => undefined);` (fire-and-forget, never awaited) followed immediately by a synchronous-failing `ping()` check in `createStore`'s own startup probe, which always throws before the connection can complete, triggering the `console.warn('[workers] Redis unavailable...')` fallback to `MemoryStore` on every single invocation, Redis up or down.
- **Severity:** **P0**
- **Risk:** Gateway and worker each run their own private in-memory queue; `inbound_message`, `payment_webhook`, `provider_webhook` jobs the gateway enqueues never reach the worker; all queue/lock/idempotency/rate-limit state is lost on every restart.
- **Reproduced:** probe1 (original defect).
- **Fix:** `RedisStore` now keeps its connection attempt alive and exposes `waitUntilReady(timeoutMs)`; `createStore()` properly awaits that (default 5s via `REDIS_CONNECT_TIMEOUT_MS`) before probing, instead of racing a fire-and-forget `connect()` against a synchronous check that always lost the race. Falls back to `MemoryStore` only when Redis genuinely cannot be reached, with a warning naming the URL (password redacted) and the real reason.
- **Test proving remediation:** `store.redis.test.ts` (5 tests) against a real `redis-server` the tests start themselves — proves Redis is actually used when up, two separate `createStore()` calls share one real queue, correct fallback with a clear warning when genuinely down, and passwords never logged. Negative control: restoring the original code makes 4 of 5 fail ("expected MemoryStore to be an instance of RedisStore"). Independently re-run by the orchestrating session: full suite 677/732 passing, 0 failed, confirmed directly; `tsc --noEmit` exit 0 confirmed directly; the `onConflictDoNothing`/unique-index claims in the related webhook-durability fix (B8/D7 below) spot-checked directly in source.
- **Status:** **FIXED**

### B2. Gateway inherits the same fallback, by design per its own comment, but the comment's claim is false — **FIXED, Phase 4**

- **Fix:** same B1 fix. Additionally, the gateway's webhook route no longer treats this store as the sole correctness mechanism at all (see B8/D7 below) — even in the residual case where Redis is down at gateway startup, webhooks are delayed rather than silently dropped, recovered by a new sweeper job within ~10 minutes (tracked as PHASE4-01 below, not a full fix of that residual case).
- **Status:** **FIXED** (the "jobs silently vanish forever" failure mode is closed).

### B3. Silent fallback, no operator-visible signal

- **File/Line:** `client.ts` L17-22; neither gateway nor worker `/ready` reports store type or Redis connectivity (see B10).
- **Severity:** P1
- **Status:** OPEN

### B4. Documented Postgres bridge (`webhook_jobs` table) is dead code

- **File/Line:** `packages/workers/src/jobs/webhookJobPoller.ts` header comment L10-16; `packages/database/src/repositories/webhook-jobs.ts` `create` — never called anywhere outside the repository file itself.
- **Finding:** The documented fallback path ("a database row is the only way to bridge them" when Redis isn't configured) does not exist in practice; the gateway never writes to this table. The poller runs every 500ms against a permanently empty table. Separately, `claimBatch` flips ALL pending rows to `processing` before slicing to `batchLimit`, stranding the rest; `rescueStuck` keys off `createdAt` rather than claim time.
- **Severity:** P1
- **Status:** OPEN

### B5. Payment/provider webhook replay marker set before processing, never cleared on failure — **FIXED, Phase 4**

- **Original defect:** `setNx` on the idempotency key happened before the actual processing work; any transient failure after that point made every later retry throw "Replay detected" permanently.
- **Reproduced:** probe3 (original defect).
- **Fix:** the Redis/memory `setNx` replay marker is gone entirely. Each webhook job now claims a row in a new `webhook_event_consumers` table (added alongside the new durable `webhook_events` table — see D7 below) via a token-based claim that a lease-expired worker can't overwrite. A failure is recorded as `failed` and the retry claims cleanly again; only a row already marked `processed` is treated as a real replay, and that case now completes as a no-op rather than dead-lettering. The `providerWebhook` lock-contention compounding factor (colliding with `provider_health`'s 60s lock) is resolved as a side effect since the replay check no longer depends on that lock timing at all.
- **Test proving remediation:** `webhook-pipeline.postgres.integration.test.ts` (8 tests, real Postgres + real Redis) proves a temporary DB failure is retried to completion (consumer attempts=2, exactly 1 events row + 1 outbox row written), and a later replay of the same event completes as a no-op. `resilience-failure.simulation.test.ts`'s R8 test — which previously *asserted* the permanent-lockout bug as correct behavior — was rewritten to assert the retry completes correctly instead (a strictly stronger test, not a weakened one). Independently re-run by the orchestrating session: 677/732 passing, 0 failed.
- **Status:** **FIXED**

### B6. Rescued job with a stuck idempotency claim completes without running — **FIXED, Phase 13**

- **Original defect:** `packages/workers/src/worker.ts` `processJob` — `if (state === 'completed' || state === 'processing') { await this.queue.complete(job); return; }`. A job rescued by the stale-job reaper after a worker crash, whose idempotency claim was still `processing` (24h TTL, never released by the crash), got marked `completed` having run zero times.
- **Reproduced (original defect):** probe2-B (0 processor runs, final status `completed`).
- **Fix:** `idempotency.ts`'s `IdempotencyRecord` now carries an optional `ownerJobId`; `claim()` stores it. `queue.ts`'s `rescueStuckJobs` calls a new `releaseAbandonedClaim(key, jobId)` before re-queueing a stale job — it deletes the claim only if it is still `processing` *and* owned by that same job id, so a claim held by a different job sharing the key, or one already `completed`, is left alone.
- **Test proving remediation:** `packages/workers/src/worker-reliability.test.ts` (new, 20 tests across MemoryStore and real Redis). The core B6 scenario: worker A crashes mid-job holding the claim; replacement worker B's startup reaper rescues it and the job runs exactly once. Two scope guards: a claim held by a different job is not released; a `completed` claim is not re-run.
- **Independently verified by the orchestrating session:** code read directly in `queue.ts`/`idempotency.ts`/`worker.ts`, matching the above; `worker-reliability.test.ts` run in isolation — 20/20 passing, real Redis confirmed in the log output (`[worker] rescued 1 orphaned processing job(s) on startup`).
- **Residual risk, disclosed:** claims written *before* this fix ships carry no `ownerJobId`, so the reaper won't release them — a job that crashes during the rolling deploy of this fix can still hit B6 once, until that claim's 24h TTL expires (PHASE13-03). The fix also trusts the reaper's staleness judgment, which has no heartbeat to rely on (B10, still open) — PHASE13-04.
- **Status:** **FIXED**

### B7. `promoteDelayed()` races and duplicates jobs — **FIXED, Phase 13**

- **Original defect:** `packages/workers/src/queue.ts` `promoteDelayed` — `zrem`'s return value was ignored, so concurrent promoters (5 worker loops per process, plus a periodic sweep timer per replica) could each `rpush` the same job id, and two workers then processed the same job concurrently. Affected every retried job, including non-idempotent ones like message sends.
- **Reproduced (original defect):** probe2-A (duplicate id in ready list); independently re-reproduced by the orchestrating session below.
- **Fix:** `zrem` is now the claim itself — `rpush` (and the promoted-count increment) only happens if `zrem` returned 1. Redis executes `ZREM` atomically, so for a given id exactly one concurrent caller wins. `promoteDelayed` now returns the number of jobs *that call* promoted (`Promise<number>`, was `void`); both callers ignore the value.
- **Test proving remediation:** `worker-reliability.test.ts` — five concurrent promoters over the same due jobs push each id onto the ready list exactly once (MemoryStore and real Redis); an end-to-end run with 2 managers × 5 loops where a job fails once confirms it is run exactly twice (fail + retry), not more.
- **Independently verified by the orchestrating session:** code read directly in `queue.ts`, matching the above. The orchestrating session also independently reproduced the original defect as its own negative control: reverted `promoteDelayed` to the naive (return-value-ignored) form, re-ran the concurrent-promoters test, and got the exact failure `expected 100 to be 20` (every one of 20 due jobs pushed 5 times) — then restored the fix and confirmed the restored file's SHA-256 matched the pre-revert fix byte-for-byte, and all 20 tests in the file passed again.
- **Status:** **FIXED**

### B8. Gateway acknowledges a webhook, marks it seen, then can still drop it — **FIXED, Phase 4**

- **Original defect:** the in-memory `recentWebhooks` map was written and 200 returned *before* the durable enqueue completed, so a backpressure or store error silently lost the webhook while the provider's own redelivery got rejected with 409.
- **Fix:** the in-memory `recentWebhooks` map is removed entirely. The gateway's webhook route now follows the full pipeline: receive → verify signature over the exact raw bytes → validate shape → identify provider/app/tenant → **atomic DB claim against the new `webhook_events` table's unique index** (the actual uniqueness-enforcement point, see D7) → wait for enqueue to succeed → only then acknowledge 200. A duplicate-of-already-enqueued event gets 200 with `duplicate:true` and nothing is re-enqueued; a DB write failure gets 503 (never falsely acknowledged); an enqueue failure also gets 503, but the durable row is kept with its lease released so the provider's own retry completes the enqueue without resending jobs that already went out. A new recovery-sweeper worker job (`webhook_event_recovery`) re-enqueues any row that was durably saved but never successfully reached the queue (e.g. a gateway crash between the two steps).
- **Test proving remediation:** `webhook-durability.simulation.test.ts` (8 tests, through the real gateway over HTTP) covers concurrent deliveries, the same event id arriving from two different providers (correctly treated as distinct, since uniqueness is scoped to `(provider_id, provider_event_id)`), a DB outage returning 503 then a retry succeeding with 200, a partial enqueue failure recovering via the sweeper, and the dedicated Stripe billing webhook route. This test explicitly reproduces the original Phase-0 "probe3" scenario and proves it now resolves correctly. `webhook-pipeline.postgres.integration.test.ts` additionally proves, using a genuinely separate OS process with fresh memory (not just a fresh test context), that a post-"restart" redelivery is still correctly recognized as a duplicate because the durable DB row — not any in-memory state — is the actual source of truth. Independently re-run by the orchestrating session: 677/732 passing, 0 failed.
- **Status:** **FIXED**

### B9. No idempotency key on message-sending jobs; send-then-write-then-throw retries re-send

- **File/Line:** `packages/workers/src/jobs/{messageDelivery,receiptPipeline,keywordResponseDelivery}.ts`
- **Finding:** None of these carry an idempotency key. Each sends via the provider, then writes to the DB, then throws on a DB failure — the resulting retry re-sends the message/receipt/reply. (Not currently enqueued by production code per this inventory — but see CI/CD inventory for confirmation these stay dormant.)
- **Severity:** P1 (would be P0 if any path starts enqueueing these in production)
- **Status:** OPEN

### B10. No heartbeat; stale-job reaper runs on inconsistent thresholds and recovers crashed webhook jobs into the same B5/B6 traps

- **File/Line:** `queue.ts` `rescueStuckJobs` L186-214; invoked with a 5-minute default at one startup site, a 2-minute default at another, and every `reconciliationIntervalMs` (300s) on a timer — three different effective windows.
- **Finding:** `updatedAt` is only written at dequeue time, so a legitimately long-running job can be rescued (and double-processed via B7) while still genuinely in progress, especially during rolling deploys. The reaper also does a full `SCAN` of every job key every pass (O(total jobs), every 5 minutes) and its `setInterval` callback has no try/catch, so a transient store error becomes an unhandled rejection that can crash the worker process outright (default Node behavior).
- **Severity:** P1 / P2 (bundled)
- **New sub-finding from Phase 13 (PHASE13-01, not fixed, explicitly deferred to this finding):** `rescueStuckJobs` itself has the same unclaimed-race shape B7 had — two replicas reaping concurrently each push the same stale job id, probed directly by the Phase 13 agent on both MemoryStore and real Redis (`rescued: [1,1]`, same job id in both ready lists). The Phase 13 B6 fix limits the damage for idempotency-keyed jobs (the duplicate copy hits the "processing → skip" dedup instead of running twice) but jobs without an idempotency key are still double-run. Left unfixed deliberately — it is reaper-claim territory, i.e. this finding, not B6/B7's.
- **Status:** OPEN (now carrying PHASE13-01 as a confirmed, probed sub-instance)

### B11. Graceful shutdown is broken

- **File/Line:** `services/worker/src/index.ts` `shutdown` L139-167; `worker.ts` `stop` L74-79
- **Finding:** The drain loop waits on `manager.isRunning()`, which only flips false *inside* `stop()` — called after the loop — so the process always sleeps the full 30s while worker loops keep dequeuing NEW jobs the entire time; `getInFlight()` exists but is never consulted. `manager.stop()` itself then waits on all loops with no timeout, and `ctx.signal` (the abort signal) is never read by any job processor, so a genuinely hung job blocks shutdown forever until the platform's hard kill.
- **Severity:** P1
- **Status:** OPEN

### B12. Worker `start` script is unbuildable

- **File/Line:** `services/worker/package.json` — `"build": "tsc --noEmit"` emits no `dist/`, but `"start": "node dist/index.js"`.
- **Finding:** A `start`-based deploy of the worker service cannot boot as configured. (The deploy workflow's worker step is an `echo` placeholder, so the real launch command could not be verified from CI alone — flagged for the CI/CD re-run agent to confirm.)
- **Severity:** P1
- **Status:** OPEN

### B13. `/ready` on both gateway and worker reports healthy regardless of the B1 fallback

- **File/Line:** `services/worker/src/index.ts` L117-125 (`/ready` checks only `manager.isRunning()`); `services/api-gateway/src/app.ts` L628-657 (`'in-memory'` counted as a healthy value for the rate-limiter check)
- **Severity:** P1
- **Status:** OPEN

### B14. Rate-limiter window never resets under continuous traffic

- **File/Line:** `packages/workers/src/rateLimit.ts` `limit` L19-36; `store.redis.ts incr` L131-136; `store.memory.ts incr` L47-52
- **Finding:** `incr` re-applies the full TTL on every single call (not just the first), so under steady traffic the key never naturally expires; once an app hits `maxRequests` it stays blocked indefinitely, and each blocked attempt extends the window further.
- **Severity:** P1
- **Status:** OPEN

### B15. Distributed lock throws on contention instead of waiting/skipping — **PARTIALLY FIXED, Phase 13**

- **Original defect:** `packages/workers/src/lock.ts` `withLock` — contention immediately threw rather than retrying or deferring, which was the direct mechanism behind B5's provider-webhook-vs-health-check collision (B5 itself already fixed in Phase 4 by removing that lock dependency entirely).
- **Fix:** `lock.ts` gains `acquireWithWait` (bounded exponential backoff: 25ms doubling to a 500ms cap) and `tryWithLock` (returns `{acquired:false}` on contention, never throws for contention — store errors still propagate). `withLock` itself now waits up to a default 5s before throwing the new `LockNotAcquiredError`, rather than throwing immediately. All three call sites were checked individually: `jobs/reconciliation.ts` and `jobs/providerHealth.ts` switch to `tryWithLock` and skip with a warning (each is a sweep/check every replica enqueues, so a losing replica skipping is correct — the work is already being done); `jobs/providerWebhook.ts` keeps `withLock` (now waiting) since a webhook status update must not be skipped.
- **Test proving remediation:** `worker-reliability.test.ts` — `withLock` waits for a holder that releases within the bound then runs; `withLock` gives up after the bound with `LockNotAcquiredError`; `tryWithLock` returns `{acquired:false}` and never throws; a real `provider_health` job under contention completes (skips) with `attempts=0` instead of failing into retry/dead-letter; the reconciliation job skips cleanly with no throw.
- **Independently verified by the orchestrating session:** `lock.ts` read directly in full, matching the above; `worker-reliability.test.ts` run in isolation, 20/20 passing with the real-Redis skip messages (`[provider_health] skipped p1: another health check holds the provider lock`, `[reconciliation] skipped: another reconciliation run holds the lock`) visible in the output.
- **Why PARTIALLY FIXED, not FIXED:** the register's own text also named "no lease renewal and no fencing token" as part of this finding — neither was added this phase (lock TTL is `retry.maxDelayMs`, 300s, and critical sections are short, so the implementing agent judged practical risk low, but the gap itself remains OPEN as PHASE13-05).
- **Status:** **PARTIALLY FIXED** — contention behavior (the P0-in-combination mechanism) is fixed; lease renewal/fencing is not, tracked as PHASE13-05.

### B16. Minor/Info findings (workers/queue)

- `dequeue()` is non-atomic (`lpop` → `get` → `set`); a crash in the gap leaves a job orphaned in no list, invisible to the reaper (P2).
- Dead letters and job bodies expire after 24h (`idempotencyTtlMs`); no durable Postgres record of permanently-failed payment webhooks (P1).
- `retry_processing`'s dead-letter re-drive has no lock of its own, so overlapping runs can double re-drive the same dead job (P1).
- No admin HTTP route exists to list or replay dead letters; operators are limited to `redis-cli`, which is moot while B1 is open (P1).
- The gateway's rate limiter (`rate-limiter-flexible`, separate from the workers package's own `RateLimiter`) reports `type:'redis'` whenever `REDIS_URL` is merely set, regardless of actual connectivity — a misleading readiness signal layered on top of B13 (P2).
- Fixed per-process worker concurrency (default 5) with no per-type fairness; strict priority-order scheduling can starve low-priority job types under a constant high-priority backlog (P2/P3).

---

## SECTION C — API Gateway (`services/api-gateway`)

**Reviewed:** `services/api-gateway/src/app.ts` (full, 2353 lines), `auth.ts`, `index.ts`, `jwt.ts`; cross-checked `packages/routing/src/index.ts`, `packages/providers/src/{base,registry}.ts` + payment adapters, `packages/shared/src/idempotency.ts`, `packages/database/src/repositories/{idempotency-records,webhook-endpoints,messaging-profiles}.ts`, `packages/workers/src/client.ts`, `packages/observability/src/redact.ts`, `packages/events/src/index.ts`.

**Runtime fact in force for every finding below:** Express `^4.19.2` does not catch promise rejections from async handlers, and there is no `process.on('unhandledRejection')` anywhere in the gateway or packages — so any uncaught async error in a route handler crashes the entire gateway process (Node ≥15 default behavior).

### Bottom line

The gateway correctly derives application identity server-side and never trusts a body-supplied `appId` (it's overwritten at auth time) — a real strength. But it is not production-certifiable: the public payment and checkout routes drop `paymentToken`/`country`/`idempotencyKey` before calling the routing engine, so every card adapter's "no token → simulated success" fallback fires on **every real payment call**, in production, against a fully configured live Stripe key. Tenant isolation stops at the application boundary — outbound webhooks fan out to every tenant of an app regardless of which tenant's payment it was, and status/refund/webhook/messaging-profile lookups ignore the tenant header entirely, letting tenant B refund tenant A's payment. Idempotency-key reuse (after TTL expiry, after a failure, or via two concurrent identical requests) hits an uncaught unique-constraint violation that **crashes the whole gateway for every tenant**. Concurrent checkout `/pay` calls can double-charge. Inbound webhooks are marked "seen" and acknowledged 200 before a fire-and-forget enqueue that can silently land in nothing a worker will ever read.

### C1. Payment/checkout routes drop `paymentToken`/`country`/`idempotencyKey` → every card adapter returns a fabricated success — **FIXED, Phase 3**

- **File/Line:** `app.ts:665` (destructures only `amount, currency, paymentMethod, providerOverride, phoneNumber`), `app.ts:706-712` (routing call omits `paymentToken`/`country`/`idempotencyKey`/`metadata`); `app.ts:1766-1778` (checkout route, same omission)
- **Evidence:** every payment adapter does `if (!this.apiKey || !paymentToken) return this.simulatedProcess(...)` and `simulatedProcess` returns `status:'success'` — confirmed in stripe.ts, nmi.ts, adyen.ts, braintree.ts, square.ts, paypal.ts, airwallex.ts, flutterwave.ts, pawapay.ts, paychangu.ts. Only the admin playground route (not the real public API) forwards `paymentToken`/`country`.
- **Severity:** **P0** — independently confirmed Section A's finding A11 at the gateway layer: this was the single most severe correctness bug found across all inventories.
- **Fix:** the payment route, checkout `/pay` route, and admin playground now validate and forward `paymentToken` (non-empty string, ≤1024 chars), `country` (2-letter, uppercased), and `metadata` (plain object, ≤16KiB), plus the already-fixed `idempotencyKey`, through to the routing engine and into the provider adapter payload. `PaymentRequest`/`PaymentRoutingRequest` in `packages/schemas/src/index.ts` are now properly typed — every `(payload as any).idempotencyKey` cast is gone. As part of the same fix, a `transactions` row is now created in `'processing'` status (via a single conditional SQL statement, no DB transaction needed, correctly avoiding D1) immediately after a successful idempotency claim and *before* any provider call, giving every adapter a real `paymentTransactionId` to build a deterministic identity from (see E7) — this also structurally improves D5 (transaction previously written only after the charge, best-effort).
- **Test proving remediation:** `payment-forwarding.simulation.test.ts` (11 tests) proves, through the real gateway → router → Stripe adapter path, that the token/country/metadata/key/transactionId all reach the adapter and that a **local HTTP server standing in for Stripe's real API** receives `POST /v1/payment_intents` with `payment_method=pm_card_visa`, the real Bearer key, and the correctly-formatted `Idempotency-Key` header — and that the gateway returns Stripe's *own* PaymentIntent id rather than a fabricated one. Independently re-run by the orchestrating session: full suite 663/695 passing, 0 failed (confirmed directly, see Phase 3 sign-off below); `tsc --noEmit` exit 0 confirmed directly; spot-checked the actual forwarding code in `app.ts` directly.
- **Status:** **FIXED** — this closes the single highest-confidence, highest-severity finding in the entire register.

### C2. Idempotency-key reuse crashes the entire gateway process — **FIXED, Phase 2**

- **Original defect:** `app.ts:682-683` (`checkAndClaim` called outside any `try`, route not wrapped in `asyncHandler`); `packages/shared/src/idempotency.ts:30-56` (comment "If failed or expired, allow re-claim" followed by a plain `insert`, no upsert/delete); same pattern on the refund route (`app.ts:914-915`)
- **Fix:** both the payment and refund routes are now wrapped in the gateway's existing `asyncHandler` utility; the underlying re-claim is now a single atomic UPSERT (see D9) that never throws 23505 on legitimate reuse; a store failure now fails closed with `503 idempotency_unavailable` (the provider is never called) instead of an unhandled rejection; a new `process.on('unhandledRejection')` safety net in `services/api-gateway/src/index.ts` logs and keeps the process alive as a last-resort backstop (deliberately not applied to `uncaughtException`, which still crashes the process — documented reasoning: one tenant's bad request should not drop every tenant's in-flight payments, and crash-and-restart would make this a repeatable outage).
- **Test proving remediation:** `payment-idempotency.simulation.test.ts` explicitly asserts zero unhandled rejections across every reuse scenario (fresh/in-progress/expired/post-failure, both payment and refund routes) and that `/health` keeps answering throughout. Independently re-run by the orchestrating session: 605/631 tests passing, 0 failed.
- **Status:** **FIXED**

### C3. Concurrent checkout `/pay` calls can double-charge — **FIXED, Phase 3 (bonus fix)**

- **File/Line:** `app.ts:1766` (`pending` status check), `app.ts:1773-1778` (charge runs), `app.ts:1782` (`markCompleted` — the actual atomic guard — happens AFTER the charge)
- **Severity:** **P0** (independently confirmed by database agent as F8.3)
- **Evidence:** the code's own comment claims "a retried/duplicated pay request can't charge twice" — false: two concurrent POSTs both pass the pre-charge `pending` check, both call `routePayment`, and only the *second write* (not the charge) is rejected with 409. By then both charges have already fired.
- **Fix:** came along with the Phase 3 idempotency-ordering fix — each checkout session now allocates its payment-attempt row keyed by `checkout_session_<session.id>` (never the session token, which is a bearer capability), so the allocation itself (not a later status write) is the atomic gate. Two concurrent `/pay` calls on the same session now produce exactly one charge and one `409`.
- **Test proving remediation:** covered by `payment-forwarding.simulation.test.ts`'s checkout-concurrency case, independently re-run (full suite 663/695 passing, 0 failed). Negative control performed by the implementing agent: reverting to the old ordering reproduced the double charge.
- **Status:** **FIXED**

### C4. Cross-tenant webhook fan-out + within-application tenant bypass on status/refund/webhook-list/delete — **FIXED, Phase 7**

- **Original defect:** outbound webhook dispatch keyed only on `appId` (the code's own comment admitted "`TransactionEvent` carries no tenantId, so dispatch can only key on appId"); status lookup, refund ownership, messaging-profile list, webhook list/delete were all app-only — chaining into tenant B being able to actually refund tenant A's leaked payment.
- **Fix:** `TransactionEvent` now carries `tenantId`/`supplierId` fields. Every event the gateway emits (payment, messaging, other, refund, checkout pay, playground, and error events) is stamped with the verified tenant from authenticated context. Worker-emitted events (`paymentWebhook`, `outboxPoller`, `messageDelivery`, `keywordResponseDelivery`, `inboundMessage`) are stamped from server-side rows, never from request bodies. Webhook dispatch now uses `findActiveByAppAndTenant` (the `findByAppId`/`findActiveByAppId` app-only variants were removed entirely, not just bypassed) and re-verifies each endpoint row before sending; an event with no tenant goes to no endpoint (a deliberate fail-closed choice, logged). Status lookup and `/refunds` now require the caller's authenticated tenant to match the event's tenant; refunds are additionally cross-checked against the durable `transactions` row's own `app_id`/`tenant_id`, refusing with 503 if that row can't be read rather than silently trusting the in-memory event. A resource owned by another tenant (or another app) now returns 404 — identical to a nonexistent resource — so a caller can't even confirm a leaked id is real.
- **Test proving remediation:** `tenant-isolation.simulation.test.ts` and `tenant-isolation.postgres.integration.test.ts` (25 adversarial scenarios each, run through the real gateway HTTP routes, the Postgres variant swapping only the DB connection for real postgres-js) prove Tenant A's own requests succeed, Tenant B (valid key for the *same* application, different tenant header) is denied on every one of status-read/refund/webhook-list/webhook-delete/messaging-profile-list, and a body-supplied tenant override never wins over authenticated context. **Negative controls: each of the 7 distinct fixes was individually reverted and re-tested — every revert broke specific tests (webhook-dispatch-by-appId-only: 2 failures; status/refund appId-only: 4; webhook/messaging-profile list-by-app-only: 4; and others below), with every file restored byte-for-byte afterward (verified with `cmp`).** Independently re-run by the orchestrating session: full suite 731/851 passing, 0 failed, confirmed directly; `tenantId` field on `TransactionEvent` and the `findByAppAndTenant`/`findActiveByAppAndTenant` repository methods spot-checked directly in source.
- **Notable process note:** the implementing agent accidentally deleted the refund amount/status checks while editing this code; an existing test caught the regression immediately, and the agent restored the checks before reporting completion — direct evidence the existing test suite is doing real work, not just accumulating green checkmarks.
- **Status:** **FIXED**

### C5. Inbound webhook ack-before-durable-enqueue → silent loss, confirmed at both gateway and database layers — **FIXED, Phase 4**

- **Fix:** see B8/D7 — same change, confirmed from the gateway side.
- **Status:** **FIXED**

### C6. `/ready` reports healthy while critical dependencies are actually down

- **File/Line:** `app.ts:628-657` — DB check is real, but rate-limiter reports `'redis'`/`'in-memory'` as both healthy (647), provider readiness is **hard-coded** `'ready'` (644) with no actual check, and the job queue (whether it silently fell back to MemoryStore per B1), the EventBus Redis connection, and required secrets (`ADMIN_API_TOKEN`, `PORTAL_JWT_SECRET`, `WEBHOOK_HMAC_SECRET`, `SECRET_ENCRYPTION_KEY`) are never checked at all.
- **Severity:** P1
- **Status:** OPEN

### C7. Admin authorization is a single shared, non-timing-safe bearer token with no identity, RBAC, or audit logging, accepted via query string

- **File/Line:** `app.ts:425-438` (`requireAdmin`, `!==` comparison, accepts `?token=` query param); applies to all ~20 admin/dashboard/observability routes including provider secrets, routing rules, and the real-traffic playground
- **Severity:** P1
- **Compounding finding:** `GET /api/dashboard/providers` (app.ts:2098) has **no auth at all** and returns every provider's fee config, routing rules, error rates and live/configured status to anyone.
- **Status:** OPEN

### C8. Admin playground bypasses tenant/consent entirely while sending real provider traffic — **FIXED, Phase 7**

- **Original defect:** `appId` taken from body, no `tenantId` passed (defaulted to `'default'`), so a recipient opted out under their real tenant was checked against tenant `'default'` instead and NOT blocked.
- **Fix:** the playground route now requires both `appId` and `tenantId`, and the pair must resolve to an active, genuinely linked application and tenant (400/403 otherwise) — consent is now checked under the real tenant, so STOP opt-outs are honored. Payments are recorded against that tenant's actual transactions instead of a fake `'admin-playground'` tenant bucket. Playground-initiated events are explicitly marked `adminInitiated: true` with a `decisionReason` prefixed `admin_playground:` for auditability. The implementing agent considered and rejected an alternative "unscoped admin send" design specifically because it would skip per-tenant consent by design — documented reasoning, not just a fix.
- **Status:** **FIXED**

### C9. Test API keys accepted for live provider traffic

- **File/Line:** `auth.ts:95` (`authenticateApplication(raw)` called with no `environment` argument); `registry.ts:253` (the environment check exists but is unused by the gateway's call site)
- **Severity:** P1
- **Status:** OPEN

### C10. No real schema validation anywhere in the gateway — presence-only checks

- **File/Line:** `app.ts:665,707` (amount: `Number(amount)`, no NaN/≤0/max/precision check), `app.ts:1716,1725` (checkout amount: only `!amount`, so `"-5"` passes), `app.ts:778` (messaging recipient/content: no format or length checks), `app.ts:2104-2106` (admin provider PATCH spreads the whole request body into config)
- **Severity:** P1
- **Status:** OPEN

### C11. Idempotency-Key is read but never forwarded to providers; weak time-bucketed fallback keys — **FIXED, Phase 3**

- **Fix:** fixed as part of the same C1 remediation — the key is now forwarded end-to-end, and (see E7) every adapter builds its provider-facing identity deterministically from `paymentTransactionId` + the client's key via a shared `buildIdempotencyIdentity()` helper, eliminating every time-bucketed or random fallback.
- **Status:** **FIXED**

### C12. Gateway's 60s response timer doesn't abort work; a late result after timeout corrupts state further

- **File/Line:** `app.ts:239-247` (writes 504 without aborting the handler or any in-flight provider call); `app.ts:736-768` (if routing finishes after the 504, the code tries to write a second response, catches the resulting `ERR_HTTP_HEADERS_SENT`, and in that catch block **emits a fabricated `failed` event for a payment that actually succeeded**, overwriting the idempotency record from `completed` to `failed`, then throws again attempting a third response write)
- **Severity:** P1
- **Status:** OPEN

### C13. Password-reset/verification tokens are returned in the API response whenever `NODE_ENV !== 'production'`

- **File/Line:** `app.ts:1020-1022,1079,1091` — unauthenticated `/v1/api/auth/request-password-reset` includes `passwordResetToken` in the body unless `NODE_ENV` is exactly `'production'`
- **Severity:** P1 — conditional account takeover if any staging/pre-prod deployment forgets to set `NODE_ENV=production` exactly
- **Status:** OPEN

### C14. Rate limiting runs before auth, keyed on an unvalidated attacker-chosen string — enables admin-token brute force

- **File/Line:** `auth.ts:145-151` (`const id = auth.extractKey(req) || req.ip || 'anonymous'`); admin routes authenticate via `x-admin-token`, not `x-api-key`, so sending a fresh random `x-api-key` per request gives each request a fresh rate-limit bucket
- **Severity:** P1
- **Risk:** Unlimited brute-force attempts against the single shared `ADMIN_API_TOKEN`, with `/api/dashboard/admin/verify` as a free oracle; unlimited invalid-API-key DB-lookup attempts on `/v1/api/*`.
- **Status:** OPEN

### C15. Several high-value routes have no rate limiting at all

- **File/Line:** `/refunds` (898), `/v1/portal/auth/login` (1605), `/v1/portal/auth/signup` (1533), `/v1/checkout/sessions/:token[/pay]` (1744,1760) — none sit under a rate-limited mount
- **Severity:** P1
- **Status:** OPEN

### C16. SSE stream's tenant filter is a permanent no-op — **FIXED, Phase 7**

- **Original defect:** filtered on `event.tenantId`, but `TransactionEvent` had no such field, so the filter was a permanent no-op.
- **Fix:** now that `TransactionEvent` genuinely carries `tenantId` (see C4), the admin SSE stream's tenant filter actually filters. C7 (the single shared admin token with no per-actor scoping) remains open and unrelated — this fix makes the *mechanism* capable of real tenant filtering, which matters once C7 is eventually resolved and the stream is exposed more broadly than the global admin token today.
- **Status:** **FIXED** (the filter mechanism itself; C7's actor-scoping gap is tracked separately and remains open).

### C17. Refund amount check and provider-side refund idempotency are both weak

- **File/Line:** `app.ts:951` (checked against the *original* amount, not remaining-after-prior-refunds), `app.ts:967` (client-supplied currency not validated against original); Stripe's `refund()` sends no Idempotency-Key and `http_request` retries POSTs on 5xx/network errors
- **Severity:** P1 — confirmed independently by the database agent (F8.6: refunds tracked only via in-memory EventBus history, no cumulative tracking, nothing survives restart)
- **Status:** OPEN

### C18. Minor/Info findings (gateway)

- ~~Inbound provider webhook takes `applicationId` from body metadata...~~ **FIXED, Phase 7**: Phase 4 had already partly improved this (using the transaction row when one matched) but still fell back to body metadata when no match existed. Phase 7 removed that fallback entirely — the webhook owner now comes only from a server-side lookup (the provider transaction id, scoped per-provider, or `bisPaymentTransactionId`); if nothing matches a real row, the webhook is recorded with no application/tenant attribution at all rather than trusting the body's claim. The platform-wide shared `WEBHOOK_HMAC_SECRET` itself remains a separate, still-open finding (now tracked as E10, unaffected by this fix).
- CRM actor identity (`authorName`) taken from request body — spoofable audit trail (P2). *(Still OPEN — out of scope for Phase 7, which focused on tenant/app/supplier identity, not general admin-audit identity; ties to C7.)*
- `providerOverride` in the body lets any tenant bypass platform routing/cost policy (P2).
- API keys have no scopes/capabilities — `allowedCapabilities` defined but never enforced (P2).
- Provider config/routing-rule admin changes are in-memory only, lost on restart, diverge across instances (P1, ties to Section B's per-process state findings).
- CORS defaults to `*` when `CORS_ORIGINS` unset, with no production guard (P3).
- `console.error` calls bypass the structured logger's secret-redaction entirely, risking raw DB error/PII leakage to logs (P2).
- `/live` route does not exist; `/health` is a static always-200 stub (P3).
- No SSRF guard (private/link-local IP block) on admin-configured webhook endpoint URLs (P2).
- Tenant *status* (e.g. suspended) is never checked — only link existence (P2).

---

## SECTION D — Database layer (schema, migrations, repositories, secrets, idempotency, outbox, payment state machine)

**Reviewed:** every file under `packages/database/src/schema/*.ts`, `drizzle/*.sql` + `meta/*.json`, every repository in `packages/database/src/repositories/*.ts`, `provider-secrets.ts`, `crypto.ts`; cross-checked callers in `services/api-gateway`, `packages/workers`, `packages/routing`.

### Bottom line — and the single most severe finding across all of Phase 0

**The neon-http Postgres driver throws on every call to `db.transaction()`** (confirmed directly in `drizzle-orm/neon-http/session.js`: `throw new Error("No transactions support in neon-http driver")`). The platform's only transactional call site — `runInTransaction` in the payment-webhook processor — therefore fails on every single invocation against a real Neon database. Combined with Section B's finding that the webhook idempotency marker is set *before* this call, every payment webhook permanently fails and then permanently "replay"-locks on retry. **This single defect means no payment webhook has ever successfully completed against a real database connection in this architecture**, and it was invisible because the entire test suite runs against a mocked database (`packages/simulation/src/db.ts`) whose `runInTransaction` stub is `async (fn) => fn(null)` — it never throws.

Beyond that: the documented duplicate-charge-prevention unique index on `transactions` (`idx_transactions_idempotency`) is declared in the Drizzle schema and in the migration snapshot JSON, but **no actual `CREATE UNIQUE INDEX` migration ever created it** — meaning every database built by running the migrations from zero is missing this constraint, and `drizzle-kit check` cannot catch the drift because the snapshot itself already (falsely) claims it exists. The payment state machine's `'unknown'`/ambiguous-outcome state is real in code but unreachable in storage: it gets mapped down to `'pending'` and stored against a randomly generated UUID that can never be matched to a real provider transaction id, so nothing can ever reconcile it. Shared-phone-number conversations have no column at all for the business/sender number — independently confirming Section A/B's finding from the schema side.

### D1. `db.transaction()` always throws on the real driver; the only transactional call site is dead on arrival — **FIXED (de-risked), Phase 4**

- **Original defect:** the sole production caller, `paymentWebhook.ts`'s `runInTransaction`, always threw on the real neon-http driver, invisible behind a test mock that never threw.
- **Fix:** Phase 4 removed this call site entirely. `persistEffectsOnce` now writes the events row and outbox row in a single SQL statement (at most once per event, keyed off the new durable `webhook_events`/`webhook_event_consumers` claim), with no `db.transaction()` call anywhere in the path. `runInTransaction` itself still exists in `packages/database/src/transactions.ts` and the underlying neon-http driver limitation is unchanged — but it now has **zero callers** anywhere in the codebase (confirmed by the implementing agent's grep).
- **Status:** **FIXED (de-risked)** — the dangerous call site is gone, so the P0 blast radius (every payment webhook permanently failing) no longer applies. The underlying driver limitation remains true in the abstract and is noted here as a standing constraint: **no future phase should reintroduce a `db.transaction()` call against this connection** — use the single-statement/`ON CONFLICT` pattern Phases 2-4 established instead.

### D2. Even with a transaction-capable driver, the outbox write would not be atomic — **FIXED, Phase 4**

- **Fix:** same Phase 4 change as D1 — `persistEffectsOnce` writes both the events row and the outbox row in one statement rather than two independent auto-committed calls, so this concern is now moot along this path.
- **Status:** **FIXED**

### D3. Documented duplicate-charge unique index exists only in the schema/snapshot, not in any migration — **FIXED, Phase 2**

- **Fix:** migration `0013_idempotency_request_hash_and_transactions_unique.sql` adds `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions (app_id, tenant_id, idempotency_key)`, preceded by a `DO` block that refuses to proceed (raises an exception, deletes nothing) if real duplicate-keyed rows already exist in `transactions`, per the correct no-silent-data-destruction principle. A separate journal-timestamp bug (drizzle-kit's auto-generated `when` was earlier than 0012's hand-set value, which would have made every already-migrated database silently skip 0013 under the migrator's newer-than-last-applied rule) was found and fixed in the same pass.
- **Test proving remediation:** reproduced the original defect first — against a real local PostgreSQL 16 instance, migrated 0000-0012 from zero, confirmed no `idx_transactions_idempotency` existed via `pg_indexes` and that two duplicate-keyed transactions inserted successfully (`INSERT 0 2`). After applying 0013: `idempotency.postgres.integration.test.ts` (14 tests, independently re-run by the orchestrating session) proves the index is UNIQUE on the correct columns, a literal duplicate insert fails with Postgres error 23505 on `idx_transactions_idempotency`, NULL-keyed transactions never collide, and migration 0013 applies cleanly to a database already migrated through 0012. Negative-check performed by the implementing agent: reverting the `CREATE UNIQUE INDEX` statement fails 3 of these tests, confirming the test actually exercises the fix.
- **Status:** **FIXED** (DB-level fix proven on real Postgres 16; Neon-specific re-verification remains `BLOCKED — EXTERNAL VERIFICATION REQUIRED` since this sandbox has no Neon network access — see Phase 2 verification steps below).

- **File/Line:** `schema/transactions.ts:32` (`uniqueIndex('idx_transactions_idempotency').on(appId, tenantId, idempotencyKey)`, with a comment literally claiming "prevents duplicate charges"); `drizzle/0004_add_transactions.sql:17-23` creates only non-unique indexes; confirmed absent by diffing every `CREATE [UNIQUE] INDEX` in the SQL files against `meta/0012_snapshot.json`
- **Severity:** **P0** (the specific DB-constraint-backed uniqueness the certification spec requires for payment idempotency does not exist in any database built from these migrations)
- **Risk:** Permanent and invisible drift — `drizzle-kit generate` will never re-emit this index because the snapshot already (incorrectly) claims it exists, and CI's `drizzle-kit check` only validates snapshot/journal internal consistency, not migration-SQL-vs-snapshot correctness.
- **Status:** OPEN

### D4. Payment `'unknown'`/ambiguous outcome is unreconcilable once stored — **FIXED, Phase 6**

- **Original defect:** the gateway collapsed `'unknown'` into `'pending'`, and the timeout path generated a throwaway `randomUUID()` as the provider-transaction-id — unrelated to anything the provider would ever send back, and no reconciliation job read the `transactions` table at all.
- **Confirmed still fully open after Phase 3** (the implementing agent explicitly re-verified this rather than assuming Phase 3's reordering had incidentally fixed it).
- **Fix:** a provider timeout now produces a genuinely distinct `'unknown'` row, keyed by the transaction's own pre-allocated id (from Phase 3), never a throwaway random id. `provider_transaction_id` is left NULL until the provider actually confirms one — a deliberate, honest choice (NULL unambiguously means "no confirmed id" rather than a fabricated placeholder, and lets a later Stripe status lookup distinguish "never got an id" from "has a real one"). The timestamp a row first became ambiguous is recorded and never cleared. Same-key retries within the idempotency replay window get the cached `202`; after the window, a `409` honestly tells the client the outcome is still not known (never a fresh charge attempt). A row that was ever ambiguous can never be reopened as `'failed'` by an operator. A late-arriving provider webhook can now match an `unknown` row via `metadata.bisPaymentTransactionId` (which the Stripe adapter already sends) when no provider id exists yet, and fills in the provider id upon match — and real Stripe `charge.*` events are now matched on `data.object.payment_intent` rather than the charge id, fixing a related latent bug where a genuine `charge.succeeded` event (id `ch_...`) could never have matched the stored `pi_...` id.
- **Reconciliation capability built, honestly scoped:** a worker job identifies `unknown` rows and stale `processing`/`pending`/`requires_action` rows (the PHASE3-02 crash case) past a configurable threshold (15 minutes default). For Stripe specifically, a real read-only status check was added (`GET /v1/payment_intents/:id` to retrieve by known id, or `GET /v1/payment_intents/search` by the platform's own metadata when no provider id was ever received) — genuinely querying Stripe's real, documented API, not fabricated. For the other 13 adapters, which have no status-query capability at all (confirmed: none of the 14 adapters implement anything like `getStatus`), the job does **not** fabricate a check — it honestly escalates the row to `requires_reconciliation` with full context (amount, provider, how long stuck, why) via new admin endpoints (`GET /api/dashboard/payments/reconciliation` to list, `POST .../resolve` for a human to apply a resolution) that **never call a provider**. The job and the operator-resolve endpoint are both explicitly proven, by test, to make zero `processRequest()`/`refund()` calls under any circumstance — satisfying the spec's explicit "never blindly retry a potentially-chargeable operation" requirement.
- **Test proving remediation:** `payment-unknown-outcome.postgres.integration.test.ts` (3 tests, real router+registry, hung Stripe, real timeout) proves the row keeps its pre-allocated id with a NULL provider id, exactly one provider call is made with no cascade, every re-attempt path refuses, and a late webhook resolves the row. `payment-reconciliation.postgres.integration.test.ts` (4 tests, all 14 adapters instrumented with a fetch stub) proves **zero** `processRequest`/`refund` calls and exactly the expected count of Stripe GET calls, with correct outcomes across resolved/escalated/untouched cases. `payment-reconciliation.simulation.test.ts` proves the same flow end-to-end over real HTTP. Negative controls: restoring `randomUUID()` and the old unknown→pending mapping fails the timeout test; removing the never-reopen-if-ambiguous guard fails the reopen test. Independently re-run by the orchestrating session: full suite 698/793 passing, 0 failed, confirmed directly; `tsc --noEmit` exit 0 confirmed directly; the real Stripe GET-only status-check code, the zero-charge-calls comment in the reconciliation job, and the pre-allocated-id (not `randomUUID()`-primary) timeout path all spot-checked directly in source.
- **Honest limitations disclosed by the implementing agent:** no real Stripe credentials exist in this sandbox, so the retrieve/search behavior is built from Stripe's public API documentation and tested only against a fetch stub, never a live account (Stripe's search endpoint is also documented as unavailable to India-based accounts and lags real-time by about a minute — both accounted for in the implementation but unverified live). The reconciliation capability is explicitly **partial by design**: real-and-automatic for Stripe only, safe-human-escalation (never auto-resolution, never a retry) for the other 13 providers — this is the honest, correct behavior given current adapter capabilities, not a shortfall to hide.
- **Status:** **FIXED** — the exact network-death-after-provider-processed scenario the certification spec calls out by name is now correctly represented, never silently lost, and never blindly retried.

### PHASE6-01 (NEW, OPEN). Stripe Radar's fraud-downgrade (E5) could make a reconciliation status-check contradict the adapter's own earlier report
- **Finding:** disclosed by the implementing agent — because E5 (Stripe Radar downgrading an already-captured charge to `'failed'` without voiding it) remains open, a later Stripe status check performed by the new reconciliation job could report `succeeded` for a charge the adapter itself had earlier reported as `'failed'` to the platform, which the atomic transition guard would then correctly reject as an invalid transition (terminal `failed` state) — but a rejected-and-merely-logged contradiction is not the same as a flagged-for-review one.
- **Severity:** P2 (a detection/alerting gap, not a money-safety gap — the atomic guard already prevents the transition from silently applying)
- **Status:** OPEN — tracked alongside E5's own remediation.

### PHASE6-02 (NEW, OPEN). A contradicting late webhook/status-check result is only logged, not surfaced for review
- **Finding:** when a late-arriving signal (webhook or reconciliation status check) tries to apply a transition the atomic guard correctly rejects (e.g. `succeeded` arriving for a row already `failed`), the rejection is logged but not added to any operator-facing queue — an operator has no systematic way to discover these contradictions short of reading logs.
- **Severity:** P2
- **Status:** OPEN

### PHASE6-03 (NEW, OPEN). Operator resolution of an escalated payment has no real actor identity
- **Finding:** the `resolvedBy` field on the manual-resolution endpoint is free text, because the shared admin token (C7) carries no actor identity at all — this was already a known limitation (C7/GW-4.1), now concretely affecting the audit trail for financial reconciliation decisions specifically.
- **Severity:** P2 (compounds the existing C7 finding; not new in kind, newly relevant here)
- **Status:** OPEN — will be resolved once C7's admin-identity work lands.

### D5. Transaction record is written only after the provider call completes, best-effort, errors swallowed — **SUBSTANTIALLY FIXED, Phase 3 (as a side effect of the E7 ordering fix)**

- **Original defect:** `app.ts:705-731` — charge happened first via `routePayment`, then `transactionRepository.create()` wrapped in `try/catch` with the comment "Transaction creation is best-effort — don't fail the payment if it fails".
- **Fix:** the Phase 3 reordering (allocate the `transactions` row in `'processing'` status *before* calling the provider, update it afterward) means a transaction record now reliably exists before any charge is attempted — a DB write failure at allocation time now fails closed with `503 payment_record_unavailable` and the provider is never called, rather than silently swallowing the error after a successful charge. The remaining gap: if the process crashes *between* a successful provider charge and the post-call `recordPaymentAttemptOutcome` update, the row stays `'processing'` with `provider_id:'unassigned'` — correctly surfacing as a reconciliation signal rather than disappearing, but no job currently reads/acts on that signal yet (this is Phase 6's payment-state-machine/reconciliation territory, explicitly flagged as still open by the implementing agent).
- **Status:** **SUBSTANTIALLY FIXED** — the silent-total-data-loss failure mode is closed; the narrower "stuck in processing after a crash mid-call" case is now a visible, queryable signal but still lacks an automated reconciliation consumer, tracked for Phase 6.

### D6. Checkout routes the payment before atomically consuming the session (double-charge) — **FIXED, Phase 3**

- **Fix:** see C3 — same change, confirmed from the database side.
- **Status:** **FIXED**

### D7. No durable received-webhook table; no DB-enforced (provider_id, provider_event_id) uniqueness — **FIXED, Phase 4**

- **Original defect:** no table resembling `webhook_events` existed; the nearest candidate, `webhook_jobs`, had no `provider_event_id` column and no producer anywhere in the codebase.
- **Fix:** new migration `0014_webhook_events_durable_identity.sql` adds a `webhook_events` table with `provider_id`/`provider_event_id` both required and non-empty (enforced by a check constraint), and a **`UNIQUE INDEX uq_webhook_events_provider_event ON (provider_id, provider_event_id)`** — genuinely enforced by Postgres, not application code. A companion `webhook_event_consumers` table tracks per-job-type processing state with a lease token so an expired worker can't overwrite a new owner's result (this is also what fixed B5). The repository's claim operation is a single `INSERT ... ON CONFLICT (provider_id, provider_event_id) DO NOTHING RETURNING *` statement — no `db.transaction()` needed, correctly following the same pattern Phase 2/3 used to avoid the neon-http transaction trap (D1).
- **Test proving remediation:** `webhook-events.postgres.integration.test.ts` (15 tests, real Postgres 16) proves 25 simultaneous claims across 5 separate connection pools produce exactly 1 row; a literal duplicate insert fails with 23505 on the named unique index; NULL/empty event ids are rejected (23502/23514); migration 0014 applies cleanly to a database already migrated through 0013. **Negative control: with the unique index dropped, the claim fails differently (42P10) and plain inserts duplicate** — directly proving the index, not application logic, is what enforces uniqueness. Independently re-run by the orchestrating session: spot-checked the migration SQL and the repository's `onConflictDoNothing({ target: [...] })` call directly in source, confirmed exactly as described; full suite 677/732 passing, 0 failed, confirmed directly.
- **Status:** **FIXED** — closes the webhook-durability finding independently confirmed across four separate Phase-0 inventories (routing, workers, gateway, database).

### D8. Idempotency: DB enforces concurrent-claim uniqueness, but same-request-vs-different-request detection is application-only (explicit spec violation) — **FIXED, Phase 2**

- **Fix:** migration 0013 adds `request_hash text NOT NULL DEFAULT ''` to `idempotency_records` (not part of the unique index, by design — two different request bodies under the same key must never both succeed, so the index stays on `(app_id, tenant_id, operation, idempotency_key)` and the hash is compared on lookup-hit). `packages/shared/src/idempotency.ts`'s `checkAndClaim` now computes a SHA-256 hash of the request fields (sorted keys) at claim time and rejects a mismatched reuse with `409 idempotency_conflict`, including while the original request is still in flight (a waiting duplicate blocks up to `IDEMPOTENCY_WAIT_MS`, default 10s, then returns the winner's result instead of a 409 if the hash matches).
- **Test proving remediation:** `payment-idempotency.simulation.test.ts` (12 tests, run through the real gateway routes) and `idempotency.postgres.integration.test.ts` (real-Postgres) both independently re-run and confirmed by the orchestrating session: a reused key with a different request body gets 409 at every stage (fresh, in-progress, expired, post-failure); `packages/shared/src/idempotency.test.ts` (5 tests) proves the hash is stable regardless of key ordering.
- **Status:** **FIXED**

### D9. Idempotency key reuse after failure/expiry: uncaught unique violation (confirms C2 from the DB side) — **FIXED, Phase 2**

- **Fix:** the find-then-plain-insert pattern that threw Postgres 23505 on reuse was replaced with a single atomic statement: `INSERT ... ON CONFLICT (app_id, tenant_id, operation, idempotency_key) DO UPDATE ... WHERE expires_at <= now() OR (status='failed' AND request_hash matches) RETURNING *` (drizzle 0.45.2's `onConflictDoUpdate({ setWhere })`), which re-claims an expired or failed row in place instead of throwing. No explicit transaction is used or needed, correctly avoiding D1's "neon-http throws on `db.transaction()`" trap entirely. Re-claiming rotates the row id so a request that outlived its TTL cannot overwrite a new owner's in-flight result.
- **Test proving remediation:** reproduced the original crash first on real Postgres (a `failed` row present, then a plain insert → `ERROR: duplicate key value violates unique constraint "idx_idempotency_composite"`). After the fix: both `payment-idempotency.simulation.test.ts` and `idempotency.postgres.integration.test.ts` prove reuse after expiry and reuse after failure both re-claim cleanly with zero unhandled rejections, independently re-run and confirmed (605/631 passing, 0 failed, re-run twice by the orchestrating session directly).
- **Status:** **FIXED** — downgraded from the P1-escalation note since the gateway-crash blast radius (C2) is fixed in the same change.

### D10. Outbox/webhook-job claim-batch logic over-claims and treats failure as terminal with no retry — **FIXED (outbox side), Phase 5; webhook_jobs side still OPEN**

- **Original defect:** `claimBatch` flipped ALL pending rows to `processing` before slicing to `batchLimit`, stranding the rest; rescue keyed on `createdAt` not claim time; failures were terminal with no retry.
- **Fix (outbox_events):** migration `0015_outbox_consumer_lease_dead_letter.sql` adds claim/lease/dead-letter columns and a status CHECK constraint (legacy `failed` rows migrated to `dead`, stranded `processing` rows given a claim time, nothing deleted). `claimBatch` now claims oldest-first with `FOR UPDATE SKIP LOCKED` and a genuine `LIMIT`, via a reusable `= ANY(ARRAY(<locking sub-select> LIMIT n FOR UPDATE SKIP LOCKED))` pattern in a new `locking.ts` helper (proven to be necessary: a test shows the naive `IN (...)` form over-claims beyond `LIMIT 10` under one query plan). Rescue is driven by `claimed_at`, never `created_at`; a live worker can renew its claim; a worker that lost its claim cannot complete or fail the row. Failures retry with backoff, then dead-letter after a max attempt count; dead rows are replayable (`replayDead`/`replayDeadBatch`, admin routes added) without creating duplicate real-world effects.
- **Test proving remediation:** `outbox.postgres.integration.test.ts` (21 tests, real Postgres) proves: 500 rows + 5 concurrent claimers on separate connection pools → exactly 50 distinct rows each, draining to all 500 claimed with zero double-claims; a real separate OS process SIGKILLed mid-dispatch has its row correctly left alone while the claim is fresh, correctly rescued once stale, and delivered exactly once by a different worker; a worker that keeps renewing its claim is never incorrectly rescued; 6 racing replay attempts on a dead row produce exactly 1 success; completed rows cannot be replayed. Independently re-run by the orchestrating session: full suite 683/759 passing, 0 failed, confirmed directly; `locking.ts`'s `= ANY(ARRAY(...))` pattern and `claimBatch`'s `FOR UPDATE SKIP LOCKED` usage spot-checked directly in source.
- **Residual, still OPEN:** the parallel `webhook_jobs` table/`webhookJobPoller.ts` (B4) still has the identical old over-claim and `createdAt`-rescue bug — it was explicitly left alone because it's unreachable dead code (nothing writes to it, per B4/PHASE4-04), but a proper fix would need its own migration if that table is ever revived rather than removed.
- **Status:** **FIXED** for the live, load-bearing `outbox_events` path. `webhook_jobs`' copy of this bug remains OPEN but inert.

### D11. `transactionRepository.updateStatus` is a non-atomic read-then-write with no enforced transition guard at the SQL level — **FIXED, Phase 6**

- **Original defect:** validated against a snapshot read, then wrote unconditionally (no `AND status = currentStatus` in the WHERE clause); two concurrent webhooks could both validate against the same stale status with last-write-wins.
- **Confirmed before fixing:** the implementing agent verified `updateStatus` had no production callers by the time of Phase 6 (the webhook path was already atomic from Phase 5's `persistEffectsOnce`) — but the general-purpose transition function itself was still unsafe and needed fixing for the new reconciliation/timeout paths that would use it.
- **Fix:** the full valid-transition graph is now written down explicitly in `packages/database/src/transaction-status.ts` (states: `processing`, `pending`, `requires_action`, `success`, `failed`, `cancelled`, `partially_refunded`, `refunded`, `unknown`, `requires_reconciliation`). Every status change is one conditional `UPDATE ... WHERE id = $id AND status = ANY($allowedPriorStatuses)` statement — no `db.transaction()` needed, consistent with the pattern established in Phases 2-5. The result distinguishes three outcomes explicitly: `applied`, `rejected` (with the actual current status returned), or `not_found` — a follow-up read is used only to classify a miss, never to make the actual transition decision. `failed`, `cancelled`, and `refunded` are correctly terminal (nothing can move `success` back from a refunded row); the only edge back into `processing` is a narrowly-guarded reopen of an attempt that was never ambiguous (ties into D4's never-reopen-if-ambiguous rule). Migration `0016_payment_state_machine_reconciliation.sql` adds a CHECK constraint on `transactions.status`, migrating any pre-existing row with an unrecognized status to `requires_reconciliation` (original value preserved in a reason column, nothing deleted).
- **Test proving remediation:** `payment-state-machine.postgres.integration.test.ts` (12 tests, real Postgres) checks all 100 from/to status pairs against the defined graph, plus the CHECK constraint and a clean migration from an already-0015 database. Two concurrent transitions are held behind a row lock until both are provably waiting simultaneously, proving exactly one applies and the other is cleanly rejected with the winner's actual status (not silently overwritten) — proven both via direct repository calls and via the real webhook path, plus a 4-connection-pool race of 4 refunds against 20 late `success` updates correctly resolving to `refunded`, and 30 mixed concurrent outcomes producing exactly one applied transition. **Negative control: re-running the exact same concurrent interleaving through the old read-then-write code reproduces the original bug** — a recorded `success` is silently overwritten by a later `failed`. Independently re-run by the orchestrating session: full suite 698/793 passing, 0 failed, confirmed directly; the `status = ANY(<allowedFrom>)` single-statement pattern spot-checked directly in `transaction-status.ts`.
- **Status:** **FIXED**

### D12. Shared phone numbers: conversations table has no sender/business-number column (DB-side confirmation of A1/F1.2) — **FIXED, Phase 8**

- **Fix:** see A1 — same migration, confirmed from the database side. The previously fully-unscoped `findActiveByPhone` global query is replaced by the new destination-number-aware resolution chain described in A2.
- **Status:** **FIXED**

### D13. Provider secrets: AES-256-GCM at rest (sound), but no key rotation, versioning, or AAD; silent failure modes

- **File/Line:** `crypto.ts:12-26` (static scrypt-derived key, hardcoded salt string, no key-id/version column); `provider-secrets.ts:83-107` (a row that fails to decrypt — e.g. after key rotation — is silently skipped, not thrown); `provider-secrets.ts:55,87` (persistence is a silent no-op if `SECRET_ENCRYPTION_KEY` is unset)
- **Severity:** P2 (encryption itself is sound — flagged Info/positive — but operational safety around it is weak)
- **Additional finding:** the admin secret-masking function (`registry.ts:757-760`) reveals the entire secret for any value ≤10 characters, and 10 characters of any longer secret.
- **Status:** OPEN

### D14. Tenant/application identifiers are inconsistent free text with no FK, default silently to `'default'`, no row-level security or CHECK constraints anywhere

- **File/Line:** e.g. `schema/transactions.ts:14-15` (`tenantId: text(...).notNull().default('default')`) vs `schema/users.ts:21` (`tenantId: uuid(...).references(() => tenants.id)`) — inconsistent typing across tables, some UUID-FK'd, most free-text with no referential integrity
- **Severity:** P2
- **Status:** OPEN

### D15. Migration chain: snapshots 0002–0010 are missing (9 of 13), migrations 0002–0012 are hand-written, and two indexes silently diverged from their own documentation

- **File/Line:** `drizzle/meta/` only contains snapshots 0000, 0001, 0011, 0012; migration 0011's own header comment admits "this repo's own drizzle/meta/ snapshot files for migrations 0002-0010 were never committed"; migration 0008's header admits columns were "added to the Drizzle schema at some point after migration 0007 but a corresponding migration was never generated... invisible because all existing tests run against a mocked database"
- **Severity:** P2 (process/integrity risk — the codebase's own commit history documents awareness of this drift, which is how D3's missing unique index escaped notice)
- **Status:** OPEN

### D16. Minor/Info findings (database)

- `audit_logs` has no tenant column and its application FK is nullable with `ON DELETE SET NULL`, stripping attribution on app deletion (P2).
- `events.tenant_id` is nullable, so untenanted rows silently vanish from tenant-scoped queries (P2).
- Conversation unique key omits provider/channel, so an SMS thread and WhatsApp thread for the same tenant collapse into one row (P2).
- ~~`transactionRepository.findByProviderTransactionId` is unscoped by provider/app/tenant...~~ **FIXED, Phase 7**: now takes an optional provider id to scope the lookup, as part of the GW-1.1 webhook-attribution fix (see C18).
- `pruneOlderThan` on `provider_health` uses `eq` instead of `lt`, so it never deletes anything and the table grows unbounded (P3). *(Still OPEN.)*
- ~~`supplier-scope.ts` is dead code...~~ **FIXED, Phase 7**: rewritten as an exported `SupplierScope` class with injected repositories (no longer imports its own package), verifying every hop of Application → Tenant → Supplier ownership (slug resolves to an active application UUID; the tenant has an active link to that application; the supplier's own `application_id`/`tenant_id`/active-status all match) — fixing the original UUID-vs-slug type mismatch that made the comparison unconditionally false even when called. Now genuinely wired into `resolveTenantContext`, so an `x-supplier-id` header on any gateway route is verified, with new supplier-scoped routes (`GET/POST /v1/api/gateway/suppliers[/:id]`) added since none existed before. Proven by `supplier-scope.test.ts` (7 tests) plus 3 of the Phase 7 negative-control reverts specifically targeting "supplier check skips the tenant."
- ~~Several tenant-scoped gateway routes (webhook list, messaging-profile list) actually query only by `appId`...~~ **FIXED, Phase 7** — see C4.
- drizzle-kit version mismatch between root and `packages/database` package.json (P3).

---

## SECTION E — Provider adapters (14 payment + 11 messaging + 3 other)

**Reviewed:** every file in `packages/providers/src` (`base.ts`, `registry.ts`, `index.ts`, all 14 payment adapters, all 11 messaging adapters, 3 `other/` adapters); cross-checked `services/api-gateway/src/app.ts`, `packages/routing/src/index.ts`, `packages/schemas/src/index.ts`. Note: `packages/providers/src/management.ts` does not exist as a file — all management/secrets/routing-rule logic lives in `registry.ts`; only `management.test.ts` exists and imports from `./index`.

### Bottom line — independently and conclusively confirms the register's single worst finding

**No real payment can currently be made through the platform's public API.** This inventory independently re-derived and *confirmed with adapter-level evidence* what Sections A, C and D each found from a different angle: the production payment route (`app.ts:665`, `706-712`) and the hosted-checkout route (`app.ts:1773-1778`) never forward `paymentToken`, `metadata`, `country`, or `idempotencyKey`. Tracing all 14 payment adapters individually: **9 (10 outside production) silently fabricate `status:'success'`** on this exact code path even when fully configured with valid live credentials (Stripe, NMI, Flutterwave, PawaPay, PayChangu, Airwallex, Adyen, Braintree, PayPal, Square). The remaining 3 configured-but-reachable adapters (AuthorizeNet, Checkout.com, Paystack) don't fabricate success — they instead fire a **real HTTP call against a hardcoded test card number / test token / fabricated email address**, meaning the customer's actual payment instrument is never charged either way. Refunds are a local status flip with no provider call at all on 7 of 14 adapters. Four messaging providers seeded `environment:'live'` (Infobip, SignalHouse, FutureSMS, Email) make no HTTP call whatsoever and always report `'success'` — OTPs and transactional messages are reported sent but never leave the platform. None of the 25 adapters implements the canonical interface the spec requires (status query, webhook normalization, delivery-receipt normalization, capability declaration) — only `processRequest` (send/charge) exists, with `refund` and webhook verification overridden on a scattered subset.

### E1. Production payment/checkout routes fabricate success for 9-10 of 14 live-registered payment adapters — **FIXED, Phase 3**

- **Original File/Line:** `app.ts:665,706-712,1773-1778`; adapter guards: `stripe.ts:241`, `nmi.ts:206`, `flutterwave.ts:193`, `pawapay.ts:84`, `paychangu.ts:94`, `airwallex.ts:133`, `adyen.ts:218`, `braintree.ts:192`, `paypal.ts:200`, `square.ts:208`
- **Severity:** **P0** — the single highest-confidence finding in the entire register, independently confirmed by 3 separate inventories (routing [A11], gateway [C1], provider adapters [E1]) — and now fixed by the same Phase 3 change that fixed C1/A11.
- **Fix:** see C1 for the token-forwarding fix and E2 for the production kill-switch that now makes an *unconfigured* adapter throw rather than fabricate success even if somehow called in production.
- **Status:** **FIXED** — real token now reaches every adapter on the public route; combined with E2's kill-switch, an adapter can no longer silently fabricate success in production under any code path identified in this inventory.

### E2. Simulation fallback has no production kill-switch; `isConfigured()` lies for 4 payment + 6 messaging adapters — **PARTIALLY FIXED, Phase 3 (payment side only)**

- **Original File/Line:** `base.ts:275-286` (no `NODE_ENV` check anywhere in any adapter); `authorizenet.ts`, `checkout.ts`, `paystack.ts`, `twilio.ts` never override `isConfigured()`
- **Fix (payment adapters only):** `refuseSimulatedFallbackInProduction()` in `base.ts` is now called at every simulated-fallback point across all 14 payment adapters (including the base `refund()` default, which also partially addresses E9). When `NODE_ENV==='production'`, it throws `ProviderNotConfiguredError` or `MissingPaymentInputError` instead of returning a fake success; outside production it's a no-op so dev/test simulation still works. `isConfigured()` was fixed to check real credentials for AuthorizeNet, Checkout.com, and Paystack.
- **Test proving remediation:** `payment-identity-and-killswitch.test.ts` (47 tests) proves production throws with no HTTP call for every unconfigured payment adapter and every adapter missing a token, while test/dev mode still simulates as before. Negative control: disabling the kill-switch made 38 of 47 fail.
- **Still open:** the messaging side (6 messaging adapters including the 4 simulation-only "live" ones from E3 — Infobip, SignalHouse, FutureSMS, Email — plus Twilio's `isConfigured()`) was explicitly out of scope for this payments-focused phase and remains unfixed; tracked for the messaging-focused remediation phase (Phase 9-11 territory).
- **Status:** **PARTIALLY FIXED** — payment-side closed; messaging-side (E3) still OPEN.

### E3. Four "live"-registered messaging adapters are pure simulation with no HTTP call at all

- **File/Line:** `signalhouse.ts:5-54` (own file header: "not a real, findable SMS/messaging vendor"), `infobip.ts:10-50`, `futuresms.ts:5-52` (same disclaimer), `email.ts:10-42` (fabricates a fake SMTP `250 2.0.0 OK` response); registry seeds `registry.ts:294,296-305,387,389-398` all set `environment:'live'`
- **Severity:** **P0**
- **Risk:** Infobip and Email match country wildcard `'*'`, making them candidates for every tenant's messaging traffic; OTPs, STOP confirmations, and transactional SMS/email are reported delivered but never sent.
- **Status:** OPEN

### E4. Flattened failure classification + router cascade = confirmed double-charge path, now adapter-by-adapter

- **File/Line:** `base.ts:99-128` (catches every fetch error including the adapter's own internal AbortController timeout, re-throws as a generic error); 13 of 14 payment adapters' catch-all blocks map that to `status:'failed'` (exact line numbers for all 13 given in the agent's table); `routing/index.ts:249-267` retries `'failed'` on the next provider
- **Severity:** **P0** (independently confirms A10)
- **Status:** OPEN

### E5. Stripe Radar fraud-downgrade creates a *guaranteed* double charge, not just a risk — **FIXED, Phase 11-12**

- **Original defect:** a Radar-flagged charge was reported `'failed'` with no cancel/void/refund call on the PaymentIntent, which by that point already had provider-side status `succeeded` — a guaranteed double charge once the router moved to a second provider.
- **Fix:** a captured highest-risk charge is now actually refunded via `POST /v1/refunds` (own deterministic idempotency key); a merely-authorized one (`requires_capture`) is cancelled via `POST /payment_intents/:id/cancel`. `'failed'` is only reported once Stripe actually confirms the reversal; if the reversal itself can't be confirmed, the result is `'unknown'` (never retried elsewhere) rather than a false `'failed'` with money still held. This also directly resolves PHASE6-01's contradiction concern (a later Stripe status check could no longer report `succeeded` for a charge the adapter claims failed, since the charge is actually reversed now, not just mislabeled).
- **Test proving remediation:** 3 dedicated tests in `payment-ambiguity.test.ts` assert the actual refund/cancel API call happened, not merely that the reported status changed. Negative control: removing the refund/cancel call broke 4 tests.
- **Honestly flagged, not resolved by this fix:** whether a fraud block should be retried on another provider *at all* (even with the money now correctly returned first) remains an open design question — tracked below as PHASE11-02.
- **Status:** **FIXED** — the money-safety defect (dangling captured charge) is closed; the policy question of retrying fraud-blocked payments elsewhere is separately tracked.

### E6. Router's own timeout races the adapter's internal timeout and never cancels in-flight retries — **FIXED, Phase 11-12**

- **Original defect:** the router's `AbortSignal.timeout()` was created but never passed into `processRequest`/`http_request`, so an adapter's internal retry loop (up to 3×30s + backoff) kept running in the background and could still fire a real charge attempt after the router had already told the client the outcome was `'unknown'`.
- **Fix:** when the router's timeout fires, it now genuinely aborts the in-flight call — any request in flight is cancelled, a pending retry backoff wait is interrupted, and no new retry attempt can start — propagated through a context every `http_request` call reads automatically, so an adapter that doesn't explicitly forward the signal is still covered rather than requiring every one of the 14 adapters to be individually fixed to pass it through.
- **Test proving remediation:** `provider-timeout-cancellation.test.ts` (6 tests) uses an instrumented fetch with timestamps to prove no further HTTP calls occur after the router's timeout fires, with a control run confirming the same stub genuinely does retry when the router isn't involved (proving the test can actually detect the defect, not just pass trivially). Negative control: reverting the cancellation-signal delivery broke 2 dedicated tests. Independently re-run by the orchestrating session as part of the full suite: 946/1113 passing, 0 failed.
- **Status:** **FIXED**

### E7. Idempotency identity is non-deterministic across the board — confirms and extends A10/C11's finding with full per-adapter detail — **FIXED, Phase 3**

- **File/Line:** Stripe minute-bucket fallback `stripe.ts:248` (`pi_${appId}_${amount}_${currency}_${Math.floor(Date.now()/60_000)}`); raw `Date.now()` with **zero** fallback-to-client-key logic in Checkout.com (`checkout.ts:37,51`) and Paystack (`paystack.ts:39`); Adyen's body `reference` *always* uses `Date.now()` even when a client key is supplied (`adyen.ts:224`); AuthorizeNet sends no idempotency key at all and uses `Date.now()` only for an echo field (`authorizenet.ts:53`); NMI and Braintree send no idempotency key whatsoever; random-UUID fallbacks with no app/tenant scoping on Flutterwave, PayPal, Square, PayChangu, Airwallex, PawaPay
- **Severity:** **P0** — directly violates the spec's explicit ban on `Date.now()`-based payment idempotency identity, confirmed on 4 adapters using it as the *primary* mechanism (Stripe's minute-bucket, Checkout, Paystack, Adyen's always-Date.now() body field) plus several more with no deterministic identity at all.
- **Root cause for why no adapter can produce the correct `bis_<payment_transaction_id>_<idempotency_identity>` format: the platform's own transaction row is only created *after* `routePayment()` returns** (`app.ts:717`, confirmed independently in Section D's D5), so no `payment_transaction_id` exists yet when any adapter constructs its idempotency key. This is a structural, not just an implementation, gap.
- **Fix:** the structural root cause is fixed — a `transactions` row (status `'processing'`) is now allocated via a single conditional SQL statement immediately after the Phase-2 idempotency claim succeeds, *before* any provider call, giving every adapter a real, stable `paymentTransactionId`. A new `buildIdempotencyIdentity(paymentTransactionId, clientKey, opts)` helper in `base.ts` produces `bis_<payment_transaction_id>_<client key, or digest thereof if length-constrained>` as a pure function of only those two inputs — no `Date.now()`, no `Math.random()`, no `randomUUID()` anywhere in the primary identity. All 13 real adapters (Example is simulation-only) now use it, mapped to each provider's actual idempotency mechanism: Stripe/Adyen `Idempotency-Key` header, Square `idempotency_key` body field, PayPal `PayPal-Request-Id` header, Flutterwave `tx_ref`, Checkout.com `Cko-Idempotency-Key` header, Paystack/PayChangu/NMI/Braintree reference fields, PawaPay a UUID derived from the identity, Airwallex separate create/confirm identities. Calling a real adapter with no `paymentTransactionId` now throws `MissingPaymentTransactionIdError` rather than silently falling back to a banned pattern.
- **Honest limitations disclosed by the implementing agent, not glossed over:** Braintree's and NMI's real APIs have no confirmed documented idempotency-key mechanism the agent could verify, so their fields are references only, not true provider-side dedupe — flagged explicitly rather than claimed fixed. Several provider length-cap values (Checkout.com, Paystack, NMI, Flutterwave, PayChangu) are the agent's conservative estimates, not confirmed against current provider docs, and should be spot-checked before real sandbox certification (Phase 27).
- **Test proving remediation:** `payment-identity-and-killswitch.test.ts` (47 tests, `fetch` stubbed, every adapter's actual outgoing request captured) proves per-adapter that the same transaction at two different fake clock times gives the same identity, a different transaction id gives a different one, and a static source-code check confirms none of the previously-banned `Date.now()`-based patterns remain. Negative control: reintroducing `Date.now()` into the helper made 38 of 47 fail. Independently spot-checked by the orchestrating session: `grep -n "Date.now()" packages/providers/src/adapters/payments/*.ts` confirms every remaining occurrence is latency measurement or webhook-signature replay-window checking, never identity construction — with the fix's own code comments explicitly noting what each adapter's banned pattern used to be (e.g. `authorizenet.ts:25`: "instead of the old `bis_<Date.now()>` (E7)").
- **Status:** **FIXED** — the explicit spec-banned pattern is eliminated from idempotency identity construction across all 14 payment adapters, independently verified.

### E8. Three adapters fire real HTTP calls against hardcoded test instruments on the production route — **PARTIALLY FIXED, Phase 3 (bonus fix, 2 of 3)**

- **Fix (beyond the original Phase 3 brief, flagged by the implementing agent for review):** Checkout.com and AuthorizeNet now charge the forwarded real `paymentToken` instead of their hardcoded `tok_test`/`4111111111111111` test instruments (AuthorizeNet sends it as Accept.js `opaqueData`). Paystack now requires a real email from `metadata.email` instead of a fabricated `@bis-platform.invalid` address.
- **Status:** **PARTIALLY FIXED** — all 3 of the originally-identified adapters were touched; full production behavior (sandbox vs. live endpoint selection per E11) was not re-verified in this pass and remains tracked separately.

- **File/Line:** AuthorizeNet sends `cardNumber:'4111111111111111'` and ignores `paymentToken` entirely (`authorizenet.ts:58-66`), defaulting to the sandbox endpoint unless `AUTHORIZENET_SANDBOX==='false'`; Checkout.com sends `source:{type:'token',token:'tok_test'}` to the production host `api.checkout.com` (`checkout.ts:16,46-47`); Paystack sends `email:`${appId}@bis-platform.invalid`` (`paystack.ts:45`)
- **Severity:** **P0**
- **Risk:** With sandbox credentials these return realistic-looking approved transaction ids in production (fabricated success by a different mechanism than E1); none of the three ever charges the customer's actual payment instrument.
- **Status:** OPEN

### E9. Refunds are a fabricated local status flip on 7 of 14 payment adapters, with no provider call at all — **PARTIALLY FIXED, Phase 3 (production kill-switch only, not a real implementation)**

- **Fix:** `refuseSimulatedFallbackInProduction()` was also added to the base `refund()` default, so a fabricated refund is now refused (throws) in production rather than silently returning a fake success — but this is a refusal/fail-safe, not an actual implementation of real provider-side refunds for the 7 adapters that still have none. In non-production, the fabricated success path is unchanged.
- **Still open:** real refund implementations for PawaPay, PayChangu, Airwallex, AuthorizeNet, Checkout.com, Paystack, and ExamplePayment remain unwritten; tracked for a future provider-adapter-focused remediation pass.
- **Status:** **PARTIALLY FIXED** — production can no longer be silently misled by a fake refund success, but the underlying capability gap remains OPEN.

- **File/Line:** `base.ts:208-233` (default `refund()` returns `status:'success'` with a random `re_<id>`, no HTTP call); no override exists in `pawapay.ts`, `paychangu.ts`, `airwallex.ts`, `authorizenet.ts`, `checkout.ts`, `paystack.ts`, `example.ts`; gateway returns this straight to the caller as `201 {status:'success'}` (`app.ts:965-982`)
- **Severity:** **P0** (independently confirms and sharpens C17/D8.6's refund-tracking concerns — this is worse than "weak tracking," it's zero provider contact)
- **Status:** OPEN

### E10. All 7 native provider webhook signature verifiers that do exist are dead code — the gateway only ever checks its own shared secret

- **File/Line:** repo-wide grep confirms `verifyProviderWebhookSignature` (overridden with real logic in stripe, nmi, flutterwave, paychangu, airwallex, square, whatsapp) is called nowhere outside the adapter files themselves and `base.ts`; `app.ts:1853-1898` (`/v1/api/webhooks/:provider`) only validates one shared `WEBHOOK_HMAC_SECRET` header against `JSON.stringify(req.body)` rather than the captured raw body
- **Severity:** P1 (fails closed, so not an auth bypass — but means every async/ambiguous outcome from PawaPay/Adyen/Flutterwave refunds/Paystack can never be reconciled, since the webhook path that would confirm them is never cryptographically trusted at the provider level)
- **Additional findings:** several of the schemes that do exist are weak — Airwallex has no timestamp-freshness check (replayable), NMI has no replay window, Flutterwave does a static shared-secret compare rather than an HMAC; 12 of 25 adapters have no native verification scheme at all.
- **Status:** OPEN

### E11. Live/sandbox host selection is broken for 4 adapters — `ProviderConfig.environment` is never actually set

- **File/Line:** `registry.ts:129-457` (no config literal sets `environment`), `registry.ts:740` (`updateManagement` only sets it on management *state*, not the config the adapter reads); `braintree.ts:92-96`, `paypal.ts:87-89`, `square.ts:97-99`, `africastalking.ts:65-67` all branch on `this.config.environment`, which is always `undefined` → always resolves to sandbox; Adyen without `live_url_prefix` silently calls `checkout-test.adyen.com` even when registered `'live'` (`adyen.ts:127-131`)
- **Severity:** P1
- **Risk:** Live credentials sent to a sandbox host fail outright (feeding E4's cascade); conversely sandbox credentials can appear to "succeed" against a sandbox endpoint while the platform believes it's in production.
- **Status:** OPEN

### E12. Provider management configuration (environment, countries, currencies, capabilities, priority, status, routing rules, circuit-breaker state) is 100% in-memory and not persisted — independently confirms A14/D's architectural finding from the adapter-registry side

- **File/Line:** `registry.ts:92` (in-memory `Map`), `644-751`, `858-891` — only secrets are persisted to the DB (`app.ts:318-358`), and hydration is fire-and-forget (`void hydrateProviderSecretsFromDb()`), so early requests after a restart run on env-var fallback or the simulation path
- **Severity:** P1
- **Status:** OPEN

### E13. Credentials and token caches are global per provider, not per tenant — architectural, flagged for explicit confirmation

- **File/Line:** `registry.ts:89-126,498-508` — one adapter instance and one secrets map per provider serving every tenant; Airwallex and PayPal bearer-token caches are shared singleton state (`airwallex.ts:53`, `paypal.ts:73`)
- **Severity:** P1 (architectural — acceptable only if the aggregator/shared-merchant-account model is an intentional, documented design decision, which has not been confirmed)
- **Status:** OPEN — needs an explicit product decision, not just a code fix.

### E14. Minor/Info findings (provider adapters)

- Full refunds send `amount:0` on 6 adapters (Adyen, Braintree, PayPal, Square, NMI, Flutterwave) because the gateway passes `amount` through `undefined` when the client omits it, and only Stripe correctly omits the field for a full refund (P1).
- Refunds carry no idempotency key on 4 adapters that do retry on transport errors (Stripe, NMI, Flutterwave, Braintree), risking duplicate refunds (P1).
- PawaPay/Airwallex use the raw, unscoped client-supplied idempotency key as the provider-side identifier with no app/tenant prefix — two tenants reusing the same key value (e.g. `"order-1"`) collide at the provider and can cross-link transactions (P1, escalates to P0 once E1's token-forwarding gap is fixed).
- Secret masking in the admin console reveals the entire value for any secret ≤10 characters and 10 characters of longer ones (`registry.ts:757-761`) — independently confirms D13's finding from the adapter-registry side (P1).
- Vibes messaging adapter is registered `'live'` despite its own file explicitly stating "Do not treat this adapter as production-ready" (P1).
- Deterministic refund keys on Adyen/PayPal/Square collide for a second legitimate partial refund of the identical amount (P2).
- Provider-specific fields leak through the generic payload contract (`metadata.pawapayProvider`, `paychanguOperatorRefId`, `airwallexCustomerId`, etc.), defeating provider-agnostic routing (P2).
- `appId` used as the provider-side customer identity on Adyen/Square stored-card flows (P2).
- Credentials sent in plaintext request bodies (NMI, Vonage, AuthorizeNet) rather than headers — no current logging exposure found, but any future request-body logging/tracing would leak them (P2).
- `GET /api/dashboard/providers` has no admin-auth requirement at all and exposes routing rules/circuit state/configured flags (P2, independently confirms C7's compounding finding).
- Braintree never sends currency or merchantId, so charges land in the account's default currency (P2).
- None of the 25 adapters implements the canonical interface the spec requires (status query / webhook normalization / delivery-receipt normalization / capability declaration) — confirmed by a repo-wide grep returning zero matches for `normaliz|getCapabilit|getTransaction|getStatus|deliveryReceipt|inbound` (P2, architectural).

---

## SECTION F — CI/CD, deployment artifacts, complete test inventory, prior-document claims

**Reviewed:** `.github/workflows/*.yml`, all deployment config (none found: no Dockerfile, no Railway/Nixpacks config, only a minimal `apps/web/vercel.json`), `.env.example`, every `*.test.ts`/`*.simulation.test.ts`/`*.integration.test.ts` file (43 files, read and characterized individually), `docs/openapi.yaml`, and every prior claims document in the repo (`FINAL_CERTIFICATION_REPORT.md`, `PRODUCTION_READINESS_REPORT.md`, `SECURITY_AUDIT_REPORT.md`, both `DISASTER_RECOVERY.md` copies, `docs/REPOSITORY_AUDIT.md`, `docs/adr/ADR-009-cicd-pipeline.md`, `docs/operations/{DEPLOYMENT,PRODUCTION_CHECKLIST}.md`). The agent additionally *executed* `npm run lint`, `npm run type-check`, `npx vitest run`, `drizzle-kit check`, and `npm audit` directly to obtain real baseline numbers rather than relying on assumptions — these results should be independently re-confirmed in Phase 1, but are recorded here as first-pass evidence:

**Baseline numbers captured:** `vitest run` → 43 files, 600 tests, 588 passed, 0 failed, 12 skipped (both `*.integration.test.ts` files skip without `DATABASE_URL`). `npm run lint` → exits 0, "318 problems (0 errors, 318 warnings)". `type-check` passes. `drizzle-kit check` → "Everything's fine" (against the CI placeholder DB URL — this only checks internal snapshot/journal consistency, not schema-vs-migration correctness; see F5 below for why this is misleading). `npm audit --omit=dev --audit-level=critical` → 0. Full `npm audit` → 12 vulnerabilities (6 moderate, 4 high, 2 critical), all in dev tooling.

### Bottom line — the certification gate itself is theater, and every prior "PASS" claim in this repo is unsupported or directly contradicted

Every CI check is green and every prior document claims a PASS/FIXED/Remediated outcome. That green is manufactured, not earned:

- **The CI gates don't test what they claim to test.** The integration-test job can — and in this exact commit, does — pass having run **zero** actual integration tests, because both integration test files guard themselves with `skipIf(!process.env.DATABASE_URL)` and the CI job provides no database service. The build job runs `tsc --noEmit`, which produces no output at all, yet the service `package.json` scripts assume a `dist/` directory exists (`"start": "node dist/index.js"`) — **there is no way to actually boot the gateway or worker as currently configured.** The high/critical security-audit step that would catch real vulnerabilities runs with `continue-on-error: true`; only the separate prod-only critical check can fail the job.
- **The deploy pipeline is literally `echo` statements.** All three deploy jobs (API gateway, worker, admin console) print the Railway/Vercel CLI command they would run and do nothing else. Meanwhile the migration job **does** run for real against the production database on every push to main — so **production schema changes on every merge while no code ever actually deploys.** Post-deploy health verification hits a template placeholder domain (`api.company.com`) with `continue-on-error: true`, so it cannot ever fail the workflow.
- **The test suite's only coverage of the gateway runs against a mocked database that disables the exact mechanisms under certification.** The mock's idempotency-claim lookup always returns "no existing claim," so the real check-then-insert concurrency behavior and the unique-constraint-violation-on-reclaim behavior (both of which are real P0s per Sections C/D) are never exercised — and one test (`donation-system.simulation.test.ts:211-219`) sends the identical idempotency key twice and **asserts that two different charge IDs result**, i.e., it asserts the double-charge defect as correct, expected behavior. The mock's `runInTransaction` helper is a no-op passthrough that never throws — hiding that the real `db.transaction()` call throws unconditionally on every single invocation against the actual neon-http driver (independently confirmed in Section D as D1, now triple-confirmed from the test-inventory side as the literal reason this P0 has stayed invisible).
- **Every prior certification/audit/DR document in the repository makes claims the current code directly contradicts.** `DISASTER_RECOVERY.md` reports measured RTOs and "PASS" outcomes for Railway auto-restart and Neon PITR restore — infrastructure that does not exist in this repo (no Railway config, echo-only deploy jobs) — and cites a test file that does not exist. `SECURITY_AUDIT_REPORT.md` claims "CRITICAL: None outstanding in code" and describes an admin-auth mechanism (`PLATFORM_ADMIN_KEY` guarding all `/api/dashboard/*` routes) that has since been removed, leaving one route (`GET /api/dashboard/providers`) completely unauthenticated today. `PRODUCTION_READINESS_REPORT.md` scores the build step "PASS" based on conflating type-checking with actually producing a runnable artifact. These are exactly the "certification documents modified to make the project appear ready" that the user's directive explicitly, by name, told this engagement not to produce or rely on.

### F1. The integration-test CI gate can pass having run zero tests

- **File/Line:** `.github/workflows/ci.yml:74-93`; `vitest.config.integration.ts:22`; `packages/database/src/repositories/conversations.integration.test.ts:15,17`; `packages/workers/src/load.integration.test.ts:4,42`
- **Severity:** **P0**
- **Evidence:** both matching files are `describe.skipIf(!hasDb)`-guarded; the CI job has no Postgres service container and no migration step, relying solely on an optional `secrets.TEST_DATABASE_URL`; reproduced locally — 12 skipped, 0 failed, 0 run.
- **Status:** OPEN

### F2. The build gate certifies nothing deployable — no production-runnable artifact exists

- **File/Line:** `services/api-gateway/package.json:8-9`, `services/worker/package.json:8-9` (`"build":"tsc --noEmit"` + `"start":"node dist/index.js"`, with no `dist/` ever produced); every internal package's `"main":"src/index.ts"`; `deploy.yml:66-74` uploads an always-empty `services/*/dist/`
- **Severity:** **P0**
- **Risk:** The only working launch path discovered is the dev-only `ts-node-dev --transpile-only` script. Any platform deploying via `npm start` (Railway/Nixpacks default) crashes immediately with `MODULE_NOT_FOUND`.
- **Status:** OPEN

### F3. The entire deploy pipeline is non-functional theater, while production migrations run for real

- **File/Line:** `deploy.yml:129-135,153-158,176-181` (all three deploy jobs are literal `echo` statements); `deploy.yml:77-111` (the migration job runs for real against `secrets.PRODUCTION_DATABASE_URL`); `deploy.yml:190-202` (post-deploy health check hits placeholder domain `api.company.com`, both calls `continue-on-error: true`); `deploy.yml:13-22,207` (rollback job is unreachable — its trigger condition requires `target=='rollback'`, but the `target` input's `choice` options are only `all/api-gateway/worker/admin-console`)
- **Severity:** **P0** (three compounding findings: DEP-01 echo-only deploy, DEP-02 decorative health check, DEP-03 unreachable rollback)
- **Risk:** A fully green "Deploy" workflow run deploys literally nothing, while the database schema is changed in production on every push to main regardless. This is the most severe possible disconnect between CI signal and actual production state.
- **Status:** OPEN

### F4. `NODE_ENV` misconfiguration directly causes an account-takeover auth bypass and silent webhook loss

- **File/Line:** `app.ts:1020-1022,1079,1091` (password-reset/verification tokens returned in the response body to an unauthenticated caller whenever `NODE_ENV !== 'production'` exactly); `.env.example:108-109` + `packages/workers/src/client.ts:8-23` (`REDIS_URL` documented as "optional — falls back to in-memory," but that fallback is exactly Section B's B1 silent cross-process partition, meaning an unset/misconfigured `REDIS_URL` in production silently drops every acknowledged payment webhook)
- **Severity:** **P0** (both sub-findings — confirmed independently: the password-reset issue by the gateway inventory as C13, the Redis-fallback issue by the workers/gateway/database inventories as B1/C5/D7)
- **Status:** OPEN

### F5. Migration validation gate doesn't validate migration-vs-schema correctness, and no migrate-from-zero test exists anywhere

- **File/Line:** `ci.yml:157-160` (`drizzle-kit check` against a placeholder DB URL only checks internal snapshot/journal consistency); `packages/database/drizzle/meta/` contains snapshots only for 0000, 0001, 0011, 0012 (9 of 13 missing) — confirms D15; `docs/adr/ADR-009-cicd-pipeline.md:66` and `docs/operations/DEPLOYMENT.md:220` both explicitly claim "CI validates schema matches code via `drizzle-kit check`," which this inventory confirms is false
- **Severity:** P1 (documentation misrepresentation compounds the technical gap)
- **Status:** OPEN

### F6. The security-audit CI step is neutered for high/critical findings outside the final prod-only check

- **File/Line:** `ci.yml:132-138` — `npm audit --audit-level=high` runs with `continue-on-error:true`; only the separate `npm audit --omit=dev --audit-level=critical` step can actually fail the job
- **Severity:** P1
- **Status:** OPEN

### F7. Lint and type-check gates have large uncovered surface area

- **File/Line:** `eslint.config.js` (every custom rule set to `'warn'`, `varsIgnorePattern` disables unused-variable detection entirely, `apps/**` excluded); `tsconfig.json:25-26` (type-check script only covers `apps/admin-console`; checkout, developer-portal, web, landing build via `vite build` with no type gate at all)
- **Severity:** P2
- **Risk:** The payment-facing checkout frontend ships with no type-check gate whatsoever.
- **Status:** OPEN

### F8. No test exists anywhere for `services/**` (the gateway and worker themselves) or any `apps/**` frontend

- **File/Line:** `vitest.config.ts:22` (`include:['packages/**/*.test.ts']`) — `services/api-gateway/src/{app.ts,auth.ts,jwt.ts,index.ts}` and `services/worker/src/index.ts` have zero direct unit tests; the gateway is only reached indirectly, with the database fully mocked, through `packages/simulation`
- **Severity:** **P1** — this is the structural reason the entire Section A–E P0 catalogue (24 root causes in the gateway, database, and provider layers) went undetected: the only code path that exercises the real gateway routes replaces the database with a double that disables the exact mechanisms being certified.
- **Status:** OPEN

### F9. The test suite itself encodes known defects as passing, expected assertions

- **File/Line:** `donation-system.simulation.test.ts:211-219` (sends the *identical* `idempotencyKey` twice and asserts `expect(first.body.id).not.toBe(second.body.id)` — i.e., asserts the double charge); `resilience-failure.simulation.test.ts:159-189` R2 asserts `expect(unhandledRejections).toBeGreaterThan(0)` (asserts the worker crashes); `resilience-failure.simulation.test.ts:210-225` R4 and `messaging-conversation.simulation.test.ts:214` both assert `providerId === 'email'` for an SMS send (asserts the silent channel-fallback defect found independently in A9/C-channel findings)
- **Severity:** **P0** — per the user's explicit, repeated, verbatim instruction: "DO NOT hide failing tests. DO NOT weaken assertions. DO NOT delete failing tests. DO NOT convert real failures into skipped tests." These tests go further than any of those three prohibited patterns — they were written to assert the defect itself as the correct, expected outcome, which means fixing the underlying P0s in Sections B/C/D/E will make these specific tests fail and will need to be corrected as part of that remediation, not treated as a regression.
- **Status:** OPEN — flagged explicitly for remediation-phase attention: these assertions must be inverted to assert the *fixed* behavior once the underlying P0 is remediated, never weakened or left as-is.

### F10. "FIXED" admin-auth and rate-limit tests pass vacuously because `ADMIN_API_TOKEN` is never actually configured in the test harness

- **File/Line:** `security-isolation.simulation.test.ts:189-204,274-284,297-311` — three tests accept a `503 Admin access not configured` response as a passing result, because the test harness never sets `ADMIN_API_TOKEN`; a fourth test's "rate limiting" assertion is satisfied entirely by `503`s (`RATE_LIMIT_MAX_REQUESTS` is set to `'100000'` in the harness, so the real limit is never hit)
- **Severity:** P1
- **Risk:** The actual wrong-token-returns-403 / correct-token-returns-200 / admin-rate-limiting paths are never exercised by any test in the repo.
- **Status:** OPEN

### F11. OpenAPI spec would cause a 100x overcharge for any spec-compliant client, and documents routes/fields that don't exist in the gateway

- **File/Line:** `openapi.yaml:737-741` documents `amount` as "smallest currency unit (e.g. cents)" with `example: 4999`; the actual gateway (`app.ts:707`) does `amount: Number(amount)` and Stripe's adapter does `Math.round(amount * 100)` — **sending the spec's own documented example value of 4999 charges $4,999.00 instead of $49.99**; separately, the spec documents paths (`/v1/payments`, `/v1/messages`, `/v1/conversations/{id}`, `/v1/providers`) that don't exist anywhere in the actual route table (Section C's 71-route enumeration), and requires snake_case fields (`app_id`, `payment_method`) the gateway doesn't read at all, while never mentioning the `x-tenant-id` header the gateway actually requires
- **Severity:** **P0** (the unit-mismatch finding — money integrity, same class as a double-charge); P1 for the route/field mismatches
- **Status:** OPEN

### F12. Prior certification/audit/DR documents in the repository make PASS/FIXED/Remediated claims directly contradicted by the current code — the exact pattern the certifying directive explicitly prohibited producing

- **File/Line:** `DISASTER_RECOVERY.md:396-419` claims measured RTOs and "PASS" for Railway auto-restart, Neon reconnection, and "Redis fallback" (which is actually silent data loss, per B1/F4) — against infrastructure (Railway config, a working build) that does not exist in this repo, and cites a test file (`disaster-recovery.integration.test.ts`) that does not exist; `SECURITY_AUDIT_REPORT.md:14,16,27,45` claims "CRITICAL: None outstanding in code" and describes an admin-auth mechanism that has since been removed from the code, leaving a route unauthenticated today; `PRODUCTION_READINESS_REPORT.md:13-26` gives numeric readiness scores (e.g., "72/100") with a "build: PASS" claim that conflates `tsc --noEmit` with producing a runnable artifact; `FINAL_CERTIFICATION_REPORT.md` reports stale test counts and lists items as "Certified" that were only ever exercised against an in-memory mock; `docs/REPOSITORY_AUDIT.md` describes an entirely different, unrelated greenfield project and tech stack (NestJS/Supabase/Turborepo) than what actually exists in this repository (Express/Neon/Vite/npm-workspaces)
- **Severity:** **P0** — treated as a certification-process finding in its own right, not merely a documentation quality issue, because the user's directive explicitly named this exact failure mode ("DO NOT simply modify certification documents to make the project appear ready") as an out-of-bounds outcome for this very engagement. These documents must be retracted or explicitly superseded by this gap register, never cited as evidence of remediation.
- **Status:** OPEN — all six prior claims documents require an explicit retraction note once this certification concludes.

### F13. Minor/Info findings (CI/CD, deployment, docs)

- The CI-gate aggregator job (`ci-gate`) is itself logically correct — it fails unless every one of the 7 upstream jobs reports `success` — but whether branch protection on GitHub actually requires this check is unverifiable from the repository alone (`BLOCKED — EXTERNAL VERIFICATION REQUIRED`).
- No workflow uses `|| true`, `set +e`, `--passWithNoTests`, or test `.skip`/`.only` to fake a pass — the only three `continue-on-error` usages are the ones already flagged above (F6, F3's health check).
- `drizzle-kit` version mismatch between root (`^0.31.10`) and the database package (`^0.30.0`) (P3, confirms D's finding independently).
- A static regex-based test (`where-clause-and.test.ts`) that checks repositories use `and()` rather than `&&` misses nested function calls and cites a changelog file that does not exist (P3).
- One registry test claiming "application A cannot use application B's credentials" never actually presents A's key while targeting B — it only checks each key authenticates its own app (P3).
- Two files referenced by the user's own earlier list (`docs/IMPLEMENTATION_BASELINE.md`, `docs/IMPLEMENTATION_CHANGELOG.md`) do not exist at all; two more (`docs/RISK_REGISTER.md`, `docs/IMPLEMENTATION_PLAN.md`) exist but are 0 bytes (P2).
- Two unrelated artifacts sit at the repo root (`10k-websites-skill.zip`, `SKILL.md`) with no connection to the platform (Info, repo hygiene).

### F14. Full cross-reference: required-by-spec test coverage that is currently ZERO anywhere in the repository

This is the complete list from the CI/CD agent's cross-reference against the certification spec's required coverage areas — every one of these is a precondition for any later phase's "PASS" to be credible:

1. Payment idempotency (DB-constraint-backed, concurrent-identical-request) — mocked away; the one test that exists asserts the double-charge defect.
2. Provider idempotency identity format — one `toBeTruthy()` assertion; the gateway never forwards the key in the first place.
3. Webhook durable identity/uniqueness surviving restart — gateway dedup is an in-memory `Map`; worker dedup tests never leave `MemoryStore`; no DB-uniqueness test exists.
4. Transactional outbox atomicity under DB-failure-at-commit-boundaries — the mock replaces the transaction call entirely; the real one throws unconditionally (D1).
5. Payment state machine: resolving `UNKNOWN` through reconciliation to a terminal state — only the *mapping into* `UNKNOWN` is tested; resolution out of it is untested anywhere, and the reconciliation job's own test comment admits it "never reconciles against provider-reported transactions."
6. Cross-tenant authorization matrix — almost entirely zero: no same-app Tenant-A-to-B case exists at all (no second linked tenant is ever seeded in any test); supplier isolation is zero (the mock always returns `undefined` for supplier lookups); update/delete operations are untested; webhook-endpoint CRUD, consent, messaging-profiles, conversation reads, audit logs, the entire `/v1/portal/*` surface, checkout sessions, and per-tenant admin access are all zero.
7. Shared-phone-number conversation resolver with 2+ tenants — zero (confirms A3's "no test exists" finding independently).
8. STOP/YES/NO keyword tenant scoping — zero.
9. Silent channel-fallback observability — worse than zero: the existing tests assert the silent fallback as the *correct* outcome (F9).
10. Redis-backed rate limiting — zero.
11. Migration-from-zero (empty DB → all migrations → seed → full suite) — zero (F5).
12. Load tests in CI — zero; the one load-integration test is permanently skipped and the standalone loadtest script is never invoked by anything.
13. Real Redis-failure / real DB-failure resilience — zero; only `MemoryStore`-to-`MemoryStore` swaps and mock-flag toggles exist; one test (R2) asserts the worker crashing is the correct outcome.
14. Any gateway-service or worker-service unit test, and any frontend-app test — zero.
15. Admin auth with a configured token (both correct- and wrong-token cases), portal JWT auth, and HTTP-level auth/billing/consent/webhook-endpoint route tests — zero (F10).
16. Gateway request validation (negative/NaN amounts, malformed currency, etc.) and OpenAPI contract tests — zero.

---

## Running severity summary — PHASE 0 COMPLETE, all 6 inventory areas reported (Sections A–F)

**P0 — 24 distinct root causes confirmed so far, many independently cross-confirmed from 3-5 separate inventories. The headline fact: no real payment can currently be completed through the platform's public API, in either direction (charge or refund).**

1. ~~Shared-number inbound misrouting...~~ **FIXED, Phase 8** — see A1-A3/D12. Proven with a negative control that reproduces the exact original defect (prayer-request leak, wrong-tenant STOP) on the unmodified code.
2. ~~STOP/YES/NO applied to the wrong, guessed tenant as a direct consequence of #1.~~ **FIXED, Phase 8** — see A3/A4.
3. ~~Cross-provider double-charge path: all 14 payment adapters flatten ambiguous failures to `'failed'`, triggering retry on a different provider.~~ **FIXED, Phase 11-12** — see A10 for full per-adapter detail, test proof, and the specific provider error-code assumptions flagged for Phase 27 re-verification.
4. ~~**Public payment/checkout routes never forward `paymentToken`/`country`/`idempotencyKey`, so 9-10 of 14 card/mobile-money adapters' "no token" fallback fires and returns a fabricated success against a live, correctly-configured provider key — in production, on the platform's primary API route.**~~ **FIXED, Phase 3** — see C1/E1 for full remediation detail and test evidence (including a real-HTTP proof against a local mock Stripe server). This was the single highest-confidence, highest-severity finding in the register.
5. ~~`createStore()` always falls back to in-memory, partitioning gateway and worker and silently dropping cross-process jobs (B1/B2).~~ **FIXED, Phase 4** — real Redis connection bug fixed, proven against a real `redis-server`.
6. ~~Payment/provider webhook replay markers are set before processing and never cleared, making the first transient failure permanent (B5)...~~ **FIXED, Phase 4** — replaced with a token-based claim on a new durable table; proven on real Postgres+Redis.
7. ~~Rescued jobs with a stuck idempotency claim complete without ever running (B6).~~ **FIXED, Phase 13** — see B6; reaper now releases an abandoned claim it owns before re-queueing, proven on MemoryStore and real Redis.
8. ~~`promoteDelayed()` race duplicates retried jobs, including non-idempotent sends (B7).~~ **FIXED, Phase 13** — see B7; `zrem` is now the atomic claim. Independently re-reproduced by the orchestrating session as its own negative control.
9. ~~Gateway acknowledges + marks-seen a webhook before a fire-and-forget enqueue that can silently fail (B8)...~~ **FIXED, Phase 4** — persist-before-acknowledge pipeline with DB-enforced uniqueness; see B8/D7.
10. ~~**`db.transaction()` throws unconditionally on the neon-http driver...(D1).**~~ **FIXED (de-risked), Phase 4** — the dangerous call site is removed entirely; see D1 for the standing constraint this leaves for future phases.
11. **The documented duplicate-charge-prevention unique index on `transactions` exists only in the Drizzle schema/snapshot, not in any actual migration — every real database is missing it, and the drift is permanently invisible to `drizzle-kit check` (D3).** *(FIXED, Phase 2 — see D3.)*
12. **The payment state machine's `'unknown'`/ambiguous-outcome path collapses to `'pending'` against a randomly generated, unmatchable provider-transaction-id, so the exact scenario the certification spec calls out by name (network death after provider processing) can never be reconciled (D4).** *(Still OPEN — explicitly tracked for Phase 6, not addressed by Phases 2-4.)*
13. ~~Transaction records are written only after the provider charge, best-effort, with DB errors swallowed...~~ **SUBSTANTIALLY FIXED, Phase 3** — see D5; the silent-total-loss case is closed, a narrower visible-but-unreconciled residual case is tracked for Phase 6.
14. ~~Checkout can double-charge on concurrent `/pay` calls because the atomic session-consumption happens after, not before, the charge.~~ **FIXED, Phase 3** — see C3/D6.
15. ~~Idempotency-key reuse after TTL expiry, after a failure, or via concurrent identical requests hits an uncaught unique-violation that crashes the entire gateway process for every tenant (C2/D9).~~ **FIXED, Phase 2** — see C2/D9/D3/D8 for full remediation detail and test evidence.
16. ~~Outbound webhook events fan out to every tenant of an application...~~ **FIXED, Phase 7** — see C4.
17. ~~**Simulation fallback has no production kill-switch anywhere in the provider layer...(E2).**~~ **PARTIALLY FIXED, Phase 3** — all 14 payment adapters now refuse to fabricate success in production (throw instead); the 6 messaging adapters (including E3's 4 simulation-only "live" ones) remain unfixed, tracked for the messaging remediation phase.
18. **Four messaging providers seeded `environment:'live'` (Infobip, SignalHouse, FutureSMS, Email) make no HTTP call whatsoever and always return success — OTPs and transactional messages are reported delivered but never sent, for any tenant whose routing selects them (E3).**
19. ~~**Stripe Radar's fraud-downgrade path takes an already-captured charge...guaranteed double charge, not merely a risk (E5).**~~ **FIXED, Phase 11-12** — see E5; a Radar-flagged charge is now actually refunded/cancelled before being reported failed.
20. ~~Router timeout never cancels the adapter's in-flight work or internal retries...~~ **FIXED, Phase 11-12** — see E6; the router's timeout now genuinely aborts in-flight adapter work.
21. ~~**Idempotency identity is `Date.now()`-based (banned by spec)...(E7).**~~ **FIXED, Phase 3** — the structural reordering (transaction row allocated before the provider call) and a shared `buildIdempotencyIdentity()` helper eliminate every banned pattern across all 14 adapters; see E7 for full per-adapter detail and the honest limitations the implementing agent disclosed (Braintree/NMI have no confirmed provider-side dedupe mechanism to hook into).
22. ~~Three adapters (AuthorizeNet, Checkout.com, Paystack) fire real HTTP calls against hardcoded test card numbers...~~ **PARTIALLY FIXED, Phase 3 (bonus fix)** — Checkout.com and AuthorizeNet now charge the forwarded real token; Paystack now requires a real email. See E8.
23. **Refunds are a fabricated local status flip with zero provider contact on 7 of 14 payment adapters** — **PARTIALLY FIXED, Phase 3**: production can no longer be silently misled by a fake refund success (now throws instead), but real refund implementations for those 7 adapters still don't exist — see E9. This remains a capability gap, not yet a safety gap.
24. ~~The one piece of code that could disambiguate tenants on a shared number...~~ **FIXED, Phase 8** — see A2.
25. **The CI integration-test gate can pass having run zero actual tests, and currently does — both integration test files self-skip without a database, and the CI job provides none (F1).**
26. **The build gate produces no production-runnable artifact at all for either backend service; the documented `npm start` path is guaranteed to crash with `MODULE_NOT_FOUND` (F2).**
27. **The entire deploy pipeline is non-functional (`echo`-only) for all three services, while the real production database migration job runs for real on every push to main regardless — schema changes ship continuously while code never does (F3).**
28. **`NODE_ENV` misconfiguration directly causes an unauthenticated account-takeover (password-reset token returned in the response body) and, separately, silently drops every acknowledged payment webhook via the undocumented-as-dangerous Redis fallback (F4).**
29. **The test suite contains assertions that encode known P0 defects as the correct, expected outcome — a double-charge test, a worker-crash test, and two silent-channel-fallback tests all assert the defect as "passing" (F9) — meaning 588/600 "green" tests actively conceal rather than guard against several of the P0s listed above.**
30. **The OpenAPI specification documents payment amounts in the wrong unit; any client built correctly from the published spec's own example value overcharges every customer 100x (F11).**
31. **Six prior "certification"/"security audit"/"disaster recovery" documents already present in this repository assert PASS/FIXED/Remediated/"None outstanding" outcomes that this Phase-0 inventory directly and specifically contradicts, including RTO claims for infrastructure (Railway config, a working build) that does not exist in the repository at all (F12) — this is the exact failure mode the certifying directive named by name as out of bounds for this engagement, and these documents must be retracted rather than cited going forward.**

**P1 (selected; growing list, not exhaustive):** carrier-level vs per-tenant STOP conflict; swallowed consent-write failures; channel misattribution on consent checks; fail-open consent on DB error; capability/currency/country bypass via override/rule-target/fallback pool; silent-and-permanent channel switching; no country filter for messaging; Postgres webhook-job bridge is dead code; no idempotency key on send-then-write job processors; no reaper heartbeat + inconsistent thresholds (B10 — now also carrying PHASE13-01, a confirmed reaper-level duplicate-rescue race); broken graceful shutdown drain; unbuildable worker start script; misleading `/ready` signals (confirmed at the gateway too — C6); rate-limiter window that never resets; ~~lock-throws-on-contention~~ **FIXED, Phase 13** (B15 contention behavior only — lease renewal/fencing still absent, PHASE13-05); single shared non-timing-safe admin token with no RBAC/audit (C7); admin playground bypasses tenant/consent (C8); test keys usable for live traffic (C9); no real schema validation, presence-only checks (C10); Idempotency-Key never forwarded to providers, weak time-bucketed fallback (C11); 60s timer doesn't abort work and a late result corrupts state further (C12); password-reset tokens leak via response body outside `NODE_ENV=production` (C13); rate-limit keyed on attacker-controlled string, enabling admin-token brute force (C14); several high-value routes entirely unrate-limited (C15); SSE tenant filter is a permanent no-op (C16); refund amount/currency checks are weak, no cumulative tracking (C17); outbox write would not be atomic even with a working transaction (D2); DB-level request-hash for idempotency doesn't exist — application-only dedup, an explicit spec violation (D8); outbox/webhook-job claim-batch over-claims and treats failure as terminal (D10); `updateStatus` is a non-atomic read-then-write (D11); all 7 native provider webhook signature verifiers that exist are dead code, so async/ambiguous outcomes can never be reconciled at the provider-trust level (E10); live/sandbox host selection broken for 4 adapters because `ProviderConfig.environment` is never actually populated (E11); provider management config (rules, priority, circuit state) is 100% in-memory, lost on restart, diverges across replicas (E12, confirms A14/D from the registry side); credentials/token caches are global per provider not per tenant — needs an explicit product decision (E13); full refunds send `amount:0` on 6 adapters; refunds carry no idempotency key on 4 adapters that retry; unscoped client idempotency keys on PawaPay/Airwallex can cross-link two tenants' transactions at the provider.

**P2/P3 (selected):** half-open breaker unlimited probes; breaker state read-mutates and is per-process; ambiguous-event mistagging; conversation upsert race; hardcoded church wording shown to all tenants; missing CHECK IN/WHERE IS MY DRIVER keywords; non-atomic dequeue; dead-letter retention/replay gaps; scheduling fairness; unauthenticated provider-config disclosure endpoint (confirmed twice — C-minor and E14); no SSRF guard on webhook URLs; tenant status never checked, only link existence; free-text tenant/app IDs with no FK or RLS (D14); 9-of-13 missing migration snapshots and hand-written migrations (D15); secret-mask reveals full value for short secrets (confirmed three times — D13, C-minor, E14); no key-rotation support for secrets encryption; none of the 25 adapters implements the canonical provider interface (status query/webhook normalization/delivery receipts/capability declaration) — architectural, not a quick fix (E14); provider-specific fields leak through the generic payload contract, defeating provider-agnostic routing (E14); lint/type-check coverage gaps on 4-5 frontend apps (F7); drizzle-kit version skew (F13); stale/empty governance docs (F13).

---

## PHASE 0 SIGN-OFF

**Phase 0 (freeze and inventory) is complete.** All six planned read-only inventories reported: routing/messaging/shared-phone-number resolution (Section A), workers/queue infrastructure (Section B), API gateway (Section C), database layer (Section D), provider adapters (Section E), and CI/CD/deployment/test-inventory/prior-doc-claims (Section F). No files were modified during Phase 0; every finding above is traceable to a specific file:line and, where practical, independently cross-confirmed from 2-5 separate inventory passes that did not coordinate with each other.

**31 distinct P0 root causes are currently open.** Several conclusions follow directly and must govern every later phase of this engagement:

1. **No real payment or refund can currently complete through the platform's public API**, in production, against any of its 14 integrated payment providers (items #4, #17, #19, #22, #23 above).
2. **The platform's own named, critical shared-phone-number architecture is violated by the current conversation-resolution design**, not by a bug in an otherwise-sound design — the schema itself has no column that could disambiguate tenants on a shared number (items #1, #2, #24).
3. **No payment webhook has ever successfully completed against the real production database driver** — the only transactional call site throws unconditionally on neon-http, a fact invisible behind a full mocked-DB test suite (item #10).
4. **The test suite that reports 588/600 green is not a safety net for several of these P0s — it actively conceals them**, in three different ways: by mocking away the exact mechanism under test (idempotency claims, DB transactions), by never touching the gateway/worker services or any frontend app at all, and in at least three specific cases by asserting the defect itself as the correct, passing outcome (item #29).
5. **The CI and deploy pipelines cannot be trusted as evidence of anything**: the integration gate can and does pass having run zero tests, the build gate produces no runnable artifact, and the deploy pipeline is `echo`-only for every service while real production migrations run regardless (items #25, #26, #27).
6. **Six prior documents already in this repository claim certification/remediation outcomes that this inventory directly contradicts with specific evidence** — exactly the failure mode the user's directive named by name as prohibited for this engagement (item #31). These documents are superseded by this gap register as of this revision and must not be cited as evidence of readiness in any later phase.

**No PASS, FIXED, or "production ready" determination is warranted for any area of this platform at this time.** Per the user's explicit instruction, nothing in this register is marked resolved without executable evidence of remediation — all 31 P0s and the full P1/P2/P3 list above are OPEN as of this revision, and will be updated in place (not rewritten) as remediation work in Phases 2 through 31 produces test-proven fixes.

**Recommended prioritization for remediation (Phases 2 onward), given the above:** the certification spec's own phase ordering (payment idempotency → provider idempotency → webhook durability → outbox → payment state machine → tenant security → shared-phone-number safety) already matches the actual blast-radius ordering found here, with one addition — the test-suite integrity findings (F8, F9, F10) should be treated as a prerequisite fixed alongside Phase 1 baseline work, since no later phase's "tests now pass" claim can be trusted until the mocked-DB simulation suite and the defect-asserting tests are corrected to actually exercise, not bypass, the mechanisms being certified.

---

## PHASE 1 — BASELINE (independently executed and recorded by the certifying session itself, not merely cited from the CI/CD agent's report)

**Date/commit:** executed against `d8840c0` on `claude/bis-api-platform-main-reconciliation`, in the same worktree used for Phase 0. All commands below were run directly, not delegated, specifically to satisfy the anti-fabrication rule ("do not mark anything fixed/verified without executable evidence").

| Command | Exact result |
|---|---|
| `npm install` | "up to date, audited 447 packages in 2s"; 12 vulnerabilities (6 moderate, 4 high, 2 critical), all in dev tooling — matches F-section's captured number exactly. |
| `npm run lint` | Exit 0. "✖ 318 problems (0 errors, 318 warnings)". Confirms F7/CI-06: zero lint errors possible to generate today because every custom rule is `'warn'` and unused-vars detection is disabled. |
| `npm run type-check` | Exit 0. `tsc --noEmit` (root) + `admin-console`'s own type-check both clean. Confirms F7/CI-07: only 1 of 5 frontend apps is covered by this command at all. |
| `npx vitest run` (full unit suite) | **41 files passed, 2 skipped (43 total); 588 tests passed, 12 skipped (600 total); 0 failed.** Exact match to the CI/CD agent's figures — independently reproduced. |
| `npx vitest run --config vitest.config.integration.ts` | **0 tests executed, 12 skipped, 2 files skipped**, with `DATABASE_URL` confirmed unset in this environment. Directly and freshly reproduces F1/CI-02: the integration-test CI gate is vacuous as configured, right now, in this exact environment. |
| `npm run build:all` | Exit 0 for all 7 workspace builds. The 5 frontend apps produce real `dist/` output (Vite). `api-gateway` and `worker` both run `"build": "tsc --noEmit"`, which emits nothing. |
| **Direct reproduction of F2/CI-03 (the build-gate P0):** `cd services/api-gateway && node dist/index.js` | **Fails immediately:** `Error: Cannot find module '.../services/api-gateway/dist/index.js'`, `code: 'MODULE_NOT_FOUND'`, exit 1. This is now a directly-executed, first-hand reproduction (not a cited claim) that the platform's own documented production start command cannot boot the gateway as the repository is currently configured. |
| `DATABASE_URL=postgresql://placeholder:... npm run drizzle:check --workspace=@company/database` | "Everything's fine 🐶🔥", exit 0 — confirmed, and confirmed to only validate internal snapshot/journal self-consistency (per D3/F5 — it did NOT, and structurally cannot, catch the missing `idx_transactions_idempotency` unique index from D3, since the snapshot itself already (incorrectly) asserts that index exists). |
| `npm audit --omit=dev --audit-level=critical` (the actual CI-blocking command) | "found 0 vulnerabilities" — confirmed clean on production dependencies specifically. |
| `npm audit` (full) | "12 vulnerabilities (6 moderate, 4 high, 2 critical)" — all confirmed to be dev-only tooling (vite/vitest/tinypool/esbuild chain), matching F-section exactly. |

### Phase 1 conclusion

Every number the CI/CD inventory agent reported has now been independently reproduced by direct command execution in this session, with one additional direct reproduction beyond what the agent did: actually attempting to start the built gateway and capturing the exact `MODULE_NOT_FOUND` failure. **Phase 1 is complete.** The baseline is: lint/type-check/unit-tests all genuinely green on their own narrow terms; the integration-test suite runs zero tests in this environment; the build pipeline cannot produce a bootable backend service; and the migration-check gate cannot detect the specific schema-drift defect (D3) already known to exist. This baseline — not the green CI badge — is what Phase 2 onward must improve against, with every claimed fix required to be proven by a newly-passing executable test, never by narrative alone.

**Proceeding to Phase 2 (payment idempotency, DB-constraint-backed) next**, per the spec's own phase ordering and the recommended prioritization above.

---

## PHASE 2 — PAYMENT IDEMPOTENCY (DB-CONSTRAINT-BACKED) — COMPLETE

**Fixed and proven, with executable evidence independently re-run by the orchestrating session (not just accepted on the implementing agent's word):** D3 (missing unique index — now created via migration 0013, with a safety pre-check that refuses to run over existing real duplicate charges), D8 (no `request_hash` column — now added and enforced, same-key-different-request correctly rejected with `409 idempotency_conflict`), D9/C2 (uncaught unique-violation crashing the entire gateway on key reuse — now an atomic `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` re-claim with no transaction needed, correctly sidestepping D1's neon-http transaction trap).

**Verification performed:**
- The original defects were first reproduced against a real local PostgreSQL 16 instance (not just the mocked test DB) before any fix was applied, satisfying the anti-fabrication requirement that a "before" state be shown, not assumed.
- A second latent bug was caught and fixed in the same pass: `drizzle-kit generate`'s auto-stamped journal timestamp for migration 0013 was earlier than migration 0012's hand-set value, which would have caused every already-migrated database to silently skip 0013 forever under the migrator's newer-than-last-applied rule.
- Full suite independently re-run by the orchestrating session directly (not cited from the agent): `npx vitest run` → 605 passed, 0 failed, 26 skipped (631 total), confirmed twice. `npx tsc --noEmit` → exit 0. `npm run lint` → 0 errors, 320 warnings. All consistent with the implementing agent's own reported numbers.
- A pre-existing, unrelated 1-in-16 test flake in `security-isolation.simulation.test.ts` (a "forged signature" test whose mutation sometimes left the signature unchanged) was found and fixed as a byproduct — correctly flagged by the implementing agent as outside Phase 2's scope but fixed anyway since it was failing baseline runs.
- One existing test that had encoded the double-charge defect as "correct" (`donation-system.simulation.test.ts`, flagged as F9 in Phase 0) was corrected to assert the new, actually-correct behavior (same id, one transaction) rather than left asserting the bug or weakened/deleted — satisfying the user's explicit anti-fabrication instruction on this exact failure mode.

**New finding surfaced during remediation (added to the register, not yet fixed):**

### PHASE2-01. Refund-key reuse after TTL expiry can refund twice at the provider (no equivalent of the new payment-side transaction guard exists for refunds)
- **Severity:** P1
- **Evidence:** the implementing agent added a post-claim guard on the *payment* route — after a successful idempotency re-claim, the gateway checks whether this key already produced a transaction row and returns 409 without charging again if so (necessary now that the D3 index exists, otherwise a post-TTL reclaim would charge the card again and then fail to record the transaction, since that write is still best-effort per D5). No equivalent guard was added to the refund route.
- **Status:** OPEN — tracked for a future phase (likely alongside D5/refund-hardening work).

### PHASE2-02. The idempotency TTL (5 minutes) remains short relative to industry practice (Stripe itself retains keys 24h)
- **Severity:** P2 (unchanged from D's original note, now explicitly re-flagged as still open post-fix)
- **Status:** OPEN

**Outstanding BLOCKED items (correctly marked, not claimed as PASS):**
- **Neon-specific re-verification** of the migration and the constraint is `BLOCKED — EXTERNAL VERIFICATION REQUIRED` — proven on stock PostgreSQL 16 via the same Postgres SQL dialect drizzle generates, but never against the actual `neon-http` driver against a real Neon database, since this sandbox has no network path to Neon. Exact verification steps are recorded in the implementing agent's report for whoever next has Neon access: apply the migration, query `pg_indexes` for `idx_transactions_idempotency`, attempt a literal duplicate insert and confirm 23505, and point `TEST_POSTGRES_URL` at a disposable Neon branch to run the new integration test suite directly.
- **The `process.on('unhandledRejection')` safety net** in `services/api-gateway/src/index.ts` is type-checked but not exercised by any test, since importing that file starts a real server — flagged honestly rather than claimed as tested.
- **Production data risk:** if a real production database already contains duplicate-keyed transaction rows (i.e., the double-charge this index exists to prevent has already happened historically), migration 0013 will deliberately refuse to proceed rather than silently delete evidence — an operator will need to manually reconcile those rows first. This is correct, conservative behavior, not a defect, but it means Phase-2's migration cannot be assumed to apply cleanly to production without that check being run first.

Payment idempotency is no longer application-only and no longer a crash vector.

---

## PHASE 3 — PROVIDER IDEMPOTENCY IDENTITY, TOKEN FORWARDING, PRODUCTION KILL-SWITCH — COMPLETE

**This phase closed the single highest-severity, highest-confidence finding in the entire register (C1/A11/E1): the public payment and checkout routes now genuinely forward `paymentToken`/`country`/`metadata`/`idempotencyKey` end-to-end, and the explicit spec-banned `Date.now()`-based idempotency identity pattern is eliminated from all 14 payment adapters.**

**Fixed and independently verified by the orchestrating session (not merely accepted on the implementing agent's word):**
- C1, E1, C11, E7 — **fully FIXED.**
- C3, D6 (checkout double-charge) — **fully FIXED** as a direct consequence of the same reordering fix (bonus, beyond the original brief).
- D5 (best-effort transaction write) — **substantially fixed**: a transaction row now reliably exists before any charge attempt; the narrower "crash mid-call leaves a `processing` row" case is now a visible signal but still lacks an automated reconciliation consumer (tracked for Phase 6).
- E2 (production kill-switch), E8 (hardcoded test instruments), E9 (fabricated refunds) — **partially fixed**, payment-side only / 2-of-3 adapters / kill-switch-only respectively, each honestly scoped above with what remains open.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **663 passed, 0 failed, 32 skipped (695 total)**, confirmed directly, matching the implementing agent's own reported numbers exactly.
- Spot-checked `packages/providers/src/base.ts` directly: confirmed `buildIdempotencyIdentity`, `refuseSimulatedFallbackInProduction`, and `MissingPaymentTransactionIdError` exist exactly as described.
- Spot-checked `services/api-gateway/src/app.ts` directly: confirmed `paymentToken`/`country`/`metadata` validation and forwarding, and the `paymentTransactionId` allocation-before-charge flow, exist exactly as described.
- Ran `grep -n "Date.now()" packages/providers/src/adapters/payments/*.ts` directly: confirmed every remaining occurrence is latency measurement (`startTime`/`latency`) or webhook-signature replay-window freshness checking — never idempotency identity construction — with several adapters' own code comments explicitly documenting what banned pattern they replaced (e.g. "previously `reference` was ALWAYS `bis_<appId>_<Date.now()>`").
- The implementing agent's real-HTTP proof (a local server standing in for Stripe's actual API, receiving a correctly-headered request and returning a real-looking PaymentIntent id that the gateway then passes back to the client unmodified) was reviewed and is a convincing, executable proof — not merely a stubbed-`fetch` assertion.

**Honest limitations, disclosed by the implementing agent and preserved here rather than smoothed over:**
- No real provider sandbox credentials exist in this environment — every proof used a stubbed `fetch` or a local mock server standing in for a real provider, never an actual Stripe/Adyen/etc. sandbox call. This remains `BLOCKED — EXTERNAL VERIFICATION REQUIRED` for Phase 27 (sandbox provider certification).
- Several providers' documented idempotency mechanisms could not be confirmed from memory alone (Braintree, NMI specifically — their fields are references, not confirmed provider-side dedupe) and several length-cap values are conservative estimates, not confirmed against current provider API docs — flagged explicitly for re-verification before Phase 27.
- The new allocate-before-charge DB behavior (`onConflictDoNothing` against the Phase-2 unique index) was proven on local Postgres 16 only, not against Neon's `neon-http` driver — same `BLOCKED — EXTERNAL VERIFICATION REQUIRED` status as Phase 2's equivalent finding.

**New findings surfaced during remediation (added to the register, not yet fixed):**

### PHASE3-01. NMI's charge still retries up to 3 times with no real provider-side idempotency, and all adapters still classify network errors as `'failed'`, so the cross-provider double-charge cascade (A10/E4) is NOT fixed by this phase
- **Severity:** P0 (unchanged — this is the same root cause as A10/E4, now confirmed still open after Phase 3, since Phase 3 fixed *identity determinism* but not *failure classification*)
- **Status:** OPEN — explicitly out of scope for Phase 3, tracked for a dedicated remediation pass on A10/E4/PA-04 (likely bundled with Phase 11-12's provider-routing work, since the fix lives in the routing engine's retry/cascade logic plus each adapter's catch-all error handling).

### PHASE3-02. Transaction rows can still get stuck in `'processing'` with `provider_id:'unassigned'` if the process crashes between the provider call and the outcome write, with no automated reconciliation consumer yet — **FIXED, Phase 6**
- **Fix:** the Phase 6 reconciliation job explicitly scans for stale `processing`/`pending`/`requires_action` rows (this exact crash case) past a configurable threshold, alongside genuine `unknown` rows, and escalates them for human review via the same safe, never-auto-retry path described in D4.
- **Status:** **FIXED**

### PHASE3-03. Refund route still has no equivalent allocate-before-call guard (PHASE2-01, confirmed still open)
- **Status:** OPEN — unchanged from Phase 2's finding.

### PHASE3-04. Messaging-side simulation kill-switch and `isConfigured()` accuracy (E2's messaging half, E3's 4 simulation-only "live" adapters) remain completely unfixed
- **Status:** OPEN — explicitly out of scope for this payments-focused phase; tracked for the messaging remediation work (Phase 9-11 territory).

**Proceeding to Phase 4 (webhook durable identity and uniqueness) next**, per the spec's own phase ordering.

---

## PHASE 4 — WEBHOOK DURABLE IDENTITY AND UNIQUENESS — COMPLETE

**This phase closed the webhook-durability finding that had been independently confirmed across four separate Phase-0 inventories (B1/B2/B5/B8, C5, D1/D2/D7).** Webhooks now have a genuine DB-enforced unique constraint on `(provider_id, provider_event_id)`, the gateway persists durably before acknowledging rather than the reverse, the Redis-connection bug that silently partitioned the gateway from the worker is fixed, and the worker-side permanent-replay-lockout bug is fixed by tying job state to the new durable table instead of a Redis/memory marker that never cleared on failure.

**Fixed and independently verified by the orchestrating session:** B1, B2, B5, B8, C5, D1 (de-risked), D2, D7.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **677 passed, 0 failed, 55 skipped (732 total)**, confirmed directly, matching the implementing agent's own "after, plain" figure exactly.
- Spot-checked `packages/database/drizzle/0014_webhook_events_durable_identity.sql` directly: confirmed the `CREATE UNIQUE INDEX "uq_webhook_events_provider_event" ON "webhook_events" USING btree ("provider_id","provider_event_id")` statement exists exactly as described.
- Spot-checked `packages/database/src/repositories/webhook-events.ts` directly: confirmed the `.onConflictDoNothing({ target: [webhookEvents.providerId, webhookEvents.providerEventId] })` atomic claim exists exactly as described.
- The implementing agent's most convincing proof — a genuinely separate OS process with fresh memory receiving a redelivery and correctly recognizing it as a duplicate purely from the durable DB row — was reviewed and is exactly the kind of "survives restart" evidence the certification spec calls for, not merely a same-process re-assertion.

**Honest limitations and residual findings, disclosed by the implementing agent and preserved here:**

### PHASE4-01. If Redis is down at gateway startup, webhooks are now delayed (~10 min, via the recovery sweeper) rather than silently lost — but the delay itself is a new, smaller residual finding
- **Severity:** P2 (downgraded from B2/B3's original P0/P1 — the silent-total-loss failure mode is closed; this is a bounded-delay residual, not data loss)
- **Status:** OPEN — `/ready` also still does not report actual queue/store type (B13's original finding remains technically open in this narrow respect).

### PHASE4-02. Narrow at-least-once windows remain for two specific crash timings
- **Finding:** (a) a worker crash between its single-statement write and marking the consumer done means a retry that skips the write but re-runs the emit; (b) if the gateway enqueues successfully but then fails to record that fact, a retry may re-send an `inbound_message` job specifically (the payment/provider consumers are protected by the new claim mechanism; `inbound_message` was explicitly out of scope for this payments/webhooks-focused phase).
- **Severity:** P2
- **Status:** OPEN — tracked for the messaging-reliability phase (Phase 9-11 territory) for the `inbound_message` half; the payment/provider half is covered.

### PHASE4-03. Event-ordering is still whatever order events arrive in; a late "succeeded" after a "refunded" is still applied naively
- **Finding:** confirms D11's original finding is still open — identity and deduplication are now correct regardless of delivery order, but state-machine-level ordering logic was explicitly not in scope for this phase.
- **Status:** OPEN — tracked for Phase 6 (payment state machine), where it belongs.

### PHASE4-04. Several residual items explicitly left untouched, as scoped
- `webhook_jobs`/`webhookJobPoller` (B4) remain dead code — not removed, not wired up, just no longer load-bearing since the new table replaces its intended purpose.
- B6 (stuck idempotency claim completes without running), B7 (`promoteDelayed()` duplication race), B15 (lock throws on contention) are untouched — these are general queue-mechanics defects, not specific to webhook durability, tracked for Phase 13 (worker reliability).
- A pre-existing gap noted but deliberately not touched: gateway-enqueued `payment_webhook` jobs carry only `rawBody`, not a separated `type`/`data`, so certain transaction-update/receipt code paths don't fire from them — the implementing agent preserved this exactly as found rather than silently changing job-payload shape as a side effect of an unrelated phase.
- **Status:** all OPEN, each explicitly assigned to a later, more appropriate phase rather than fixed opportunistically out of scope.

**Outstanding BLOCKED items (correctly marked, not claimed as PASS):**
- **Neon-specific verification** remains `BLOCKED — EXTERNAL VERIFICATION REQUIRED` for the new migration, unique index, `ON CONFLICT`, `FOR UPDATE SKIP LOCKED`, and the single-statement write's result-shape handling — proven on stock PostgreSQL 16 only, never against the real `neon-http` driver.
- **Real provider webhook signatures** (Stripe-Signature and other native per-provider schemes) have not been tested end-to-end on the generic webhook route — only the platform's own `WEBHOOK_HMAC_SECRET` scheme was exercised. Tracked for Phase 27 (sandbox provider certification).
- **Real deployment**: gateway and worker against a managed Redis across genuine infrastructure restarts (not just separate local OS processes) remains unverified.

Webhook correctness is no longer dependent on in-memory state as the correctness mechanism, satisfying the spec's explicit requirement on this point.

---

## PHASE 5 — TRANSACTIONAL OUTBOX CORRECTNESS — COMPLETE

**Note on process:** this phase ran across two agent sessions — the first was cut off mid-work by an unrelated API rate limit (not a defect in its own work) after building most of the design (migration 0015, the claim/lease/dead-letter schema, `locking.ts`). The second session was explicitly instructed to repair and finish rather than restart, which it did, and in the process of finishing the job found and fixed a real, previously-unknown defect — see below. This is recorded as a demonstration of the engagement's process working as intended: partial work was preserved, verified, and built upon rather than discarded.

**Fixed and independently verified by the orchestrating session:** D10 (outbox side), B4/B10 (outbox side only — see residual note below).

**A new, more serious defect than originally scoped was found and fixed during this phase:**

### PHASE5-01 (now FIXED). The Postgres driver silently reported success on writes that had actually been rolled back at the commit boundary
- **Finding:** `postgres-js` 3.4.7 settles a query as soon as the statement itself finishes executing, not when its implicit transaction actually commits. For `persistEffectsOnce`'s single-statement write (introduced in Phase 4 to keep the events/outbox/transaction-status writes atomic without `db.transaction()`), this meant a commit-time failure — e.g. a constraint violation detected only at commit, or the connection being killed between statement-completion and commit — caused Postgres to roll back all three writes while the application code received a success response and the `payment_webhook` consumer marked the job `processed`, even though **nothing had actually been saved**.
- **Severity:** this is a genuine, independently-discovered P0-class silent-data-loss defect — exactly the failure mode the certification spec most explicitly prohibits ("There must be NO silent data loss") — found not by the original Phase-0 audit but by rigorous testing during remediation itself.
- **Fix:** `persistEffectsOnce` now performs one additional primary-key read (`SELECT ... FROM events WHERE id = ...`) immediately after the write and throws if the row is not actually visible, causing the job to correctly fail and retry rather than falsely reporting success. Since all three writes are one statement, this single check covers all of them.
- **Test proving remediation:** a dedicated commit-boundary test arms a Postgres trigger-based fault exactly at commit time and confirms, before the fix, that the write appeared to succeed while nothing was actually persisted (negative control: with the confirmation check disabled, two tests fail with "expected undefined to be defined" / "promise resolved instead of rejecting"); after the fix, the same scenario correctly throws and the retry then applies everything exactly once. A second scenario kills the writer connection mid-statement with the same result. Independently re-run by the orchestrating session: spot-checked the confirmation-read code directly in `webhook-events.ts`, confirmed exactly as described; full suite 683/759 passing, 0 failed, confirmed directly against real Postgres via `TEST_POSTGRES_URL`.
- **Honest scope limitation, disclosed by the implementing agent:** this same driver behavior likely affects other single-statement writes introduced in Phases 2-4 (e.g. the Phase 4 webhook claim itself) that don't have an equivalent post-write confirmation read. Only `persistEffectsOnce` was hardened in this pass; the implementing agent flagged this explicitly rather than claiming a broader fix than was actually made. **Tracked as PHASE5-02 below.**

### PHASE5-02 (NEW, OPEN). The commit-boundary silent-success driver behavior likely affects other Phase 2-4 single-statement writes that lack a confirmation read
- **Severity:** P1 (downgraded from the P0 of the one instance actually found and fixed, since this is a "likely affects" flag pending verification, not a confirmed second instance)
- **Status:** OPEN — tracked for a dedicated audit pass across all single-statement `ON CONFLICT`/claim-style writes introduced in Phases 2-5, to decide case by case whether each needs the same confirmation-read hardening `persistEffectsOnce` now has.

### PHASE5-03 (NEW, OPEN — pre-existing at HEAD, newly discovered during this phase). Every payment webhook currently dispatches two outbound customer-facing webhook deliveries instead of one, with no deduplication
- **Finding:** `paymentWebhook.ts` publishes an event directly with `id = providerEventId`, and the outbox poller separately publishes the same logical event again with `id = outbox row id`. The gateway's webhook-dispatch subscriber queues an outbound delivery for each (keyed `${endpoint.id}:${event.id}`), and `packages/events/src/webhook-delivery.ts`'s in-memory delivery map does not deduplicate across these two distinct ids, since they're genuinely different id values by construction.
- **Severity:** P1 — not a money-safety or data-loss issue, but a real reliability/trust defect: merchants' own webhook endpoints receive every payment confirmation twice.
- **Risk:** this was already true at HEAD before any of Phases 2-5 touched this code; it was only surfaced now because this phase's work required tracing the full outbox-to-delivery path in detail.
- **Status:** OPEN — tracked for a future pass on `packages/events/src/webhook-delivery.ts`'s dedup key design (likely needs to dedupe on the underlying business event rather than the dispatch-time id).

### Verification performed directly by the orchestrating session
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **683 passed, 0 failed, 76 skipped (759 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/database/src/repositories/webhook-events.ts` directly: confirmed the primary-key commit-confirmation read and throw-on-missing logic exists exactly as described.
- Spot-checked `packages/database/src/repositories/outbox-events.ts` and the new `locking.ts` directly: confirmed the `FOR UPDATE SKIP LOCKED` / `= ANY(ARRAY(...))` claim pattern exists exactly as described.

### Honest residual findings, disclosed by the implementing agent and preserved here
- **Item 3 of the original brief (do other business-state changes write an outbox row atomically?) was answered honestly, not assumed:** in production, outbox rows are written in exactly one place (`paymentWebhook.ts` → `persistEffectsOnce`); `outboxEventRepository.create` has no other production callers. Every other state-changing path (the gateway's payment/messaging/other/refunds/checkout-pay/playground routes, and the worker's `inboundMessage`/`messageDelivery`/`receiptPipeline`/`reconciliation`/`providerWebhook`/`eventProcessing` jobs) publishes straight to the event bus with no outbox at all — meaning the outbox pattern currently protects only payment webhooks, nothing else. This is an honest scope boundary, not a defect introduced by this phase, but it means the "transactional outbox" guarantee should not be assumed to extend to messaging or other event types without further work.
- **Delivery is at-least-once by design**, not exactly-once: if a worker dies after dispatching but before marking its row done, the row is legitimately redispatched after the stale window with the same id — receivers (including the platform's own internal consumers) must tolerate and deduplicate on that id. This is consistent with standard outbox-pattern semantics and is not treated as a defect.
- **BLOCKED — EXTERNAL VERIFICATION REQUIRED:** whether `neon-http` has the same commit-settling behavior as `postgres-js` (the new confirmation-read guard makes the correctness guarantee hold either way, but the underlying driver behavior itself is unconfirmed on Neon specifically); the `FOR UPDATE SKIP LOCKED`/`ANY(ARRAY())` query plan, migration 0015, and result-shape handling are proven only on stock PostgreSQL 16.15. Production deployment behavior (worker crash and Redis restart on real managed infrastructure, admin routes against a real database rather than the in-memory mock) also remains unverified in this sandbox.

**Proceeding to Phase 6 (payment state machine, including the `UNKNOWN`/reconciliation path) next**, per the spec's own phase ordering. Phase 6 inherits a notably stronger foundation than it would have otherwise: a reliable transaction-id-before-charge allocation (Phase 3), durable webhook identity (Phase 4), and now a proven-atomic outbox write with commit-boundary confirmation (Phase 5) — but D4 (the `'unknown'` outcome being stored as `'pending'` against an unmatchable id) remains explicitly unaddressed and is Phase 6's primary target.

---

## PHASE 6 — PAYMENT STATE MACHINE, `UNKNOWN` OUTCOME, AND RECONCILIATION — COMPLETE

**Note on process:** this phase was also interrupted once by an unrelated API rate limit. Per the harness's own guidance, the same agent was resumed via `SendMessage` rather than restarted — its message indicates the work was already substantively complete by the time the resume message was even processed, and the full before/after test evidence below reflects its finished state. This is a second demonstration of the engagement's resume-rather-than-restart process working correctly under real interruption.

**Fixed and independently verified by the orchestrating session:** D4, D11, PHASE3-02.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **698 passed, 0 failed, 95 skipped (793 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/database/src/transaction-status.ts` directly: confirmed the `status = ANY(<allowedFrom>)` single-statement atomic transition pattern exists exactly as described.
- Spot-checked `packages/workers/src/jobs/paymentReconciliation.ts` directly: confirmed the job's own code comment explicitly states it never calls `processRequest()`/`refund()` or any other money-moving operation.
- Spot-checked `packages/providers/src/adapters/payments/stripe.ts` directly: confirmed the new status-check code makes only real, documented read-only `GET /v1/payment_intents/:id` and `GET /v1/payment_intents/search` calls — not a fabricated check.
- Spot-checked `packages/routing/src/index.ts` directly: confirmed the timeout path now uses `request.paymentTransactionId` as its primary identity, with a `randomUUID()`-based fallback (prefixed `unknown_`) reserved only for the defensive edge case where no transaction id was set at all — not the primary path, as the original D4 defect was.

**Honest scope, as reported by the implementing agent and preserved here:** the reconciliation capability is genuinely automatic only for Stripe (the one adapter given a real, documented, read-only status-check implementation); for the other 13 payment adapters — which this register has established have no status-query capability at all — the job correctly and conservatively escalates stuck payments for human review via new admin endpoints, and is proven by test to make zero money-moving provider calls under any circumstance. This is the right engineering choice given real constraints, not a shortfall glossed over as complete.

**New findings surfaced during remediation (added to the register, not yet fixed):** PHASE6-01 (Stripe Radar contradiction detection gap, P2), PHASE6-02 (contradicting late signals are logged but not surfaced for operator review, P2), PHASE6-03 (no real actor identity on manual reconciliation resolutions, compounds existing C7, P2).

**Confirmed still explicitly open, not addressed by this phase (honestly scoped by the implementing agent rather than silently left for the orchestrating session to discover):**
- **A10/E4/PHASE3-01 (the cross-provider double-charge cascade on flattened network-error failures) remains fully OPEN.** Only the router's own timeout produces the safe `'unknown'` path this phase hardened; adapters still map network errors and 5xx responses to `'failed'`, which the router still cascades to a different provider. The existing test R7 still treats this failover as acceptable. This remains the most significant unresolved P0 in the payments area and should be the next priority after the current phase sequence reaches provider-routing territory (Phase 11-12), or sooner given its severity.
- **C17/PHASE2-01 (refunds never update the `transactions` row)** remains open.
- **E6 (adapter-internal retries continue in the background after the router has already told the client `'unknown'`)** and **E5 (Stripe Radar's fraud-downgrade not voiding the already-captured charge)** both remain open, and E5 specifically now has a concrete downstream consequence newly identified as PHASE6-01.
- **PHASE5-02 (the commit-boundary silent-success driver behavior found in Phase 5) applies to these new transitions too** — the atomic transition statements added in this phase do not yet have the same commit-confirmation read that `persistEffectsOnce` received in Phase 5. Flagged honestly by the implementing agent as an extension of the already-tracked PHASE5-02 finding, not a new separate risk.

**Proceeding to Phase 7 (multi-tenant security hard-boundary audit) next**, per the spec's own phase ordering — this shifts focus from payment-correctness (now substantially hardened across Phases 2-6) to the tenant-isolation findings cataloged across Sections A/C/D (cross-tenant webhook fan-out, within-application tenant bypass on status/refund/webhook-list/delete, the shared-phone-number conversation misrouting that remains the platform's single largest unaddressed category of P0s).

---

## PHASE 7 — MULTI-TENANT SECURITY HARD BOUNDARY — COMPLETE

**This phase closed the single most severe cross-tenant data-exposure chain in the register: the webhook-leak-then-refund path (C4), independently confirmed across four separate Phase-0 inventories.** The tenant boundary within a shared application is now genuinely enforced — not merely application identity (which was already sound before this phase) — across webhook dispatch, status lookup, refunds, webhook-endpoint and messaging-profile management, and the previously-dead supplier-ownership chain.

**Fixed and independently verified by the orchestrating session:** C4, C8, C16, and the D16/C18 bullets covering `findByProviderTransactionId` scoping, `supplier-scope.ts`, and the inbound-webhook body-trust fallback.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **731 passed, 0 failed, 120 skipped (851 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/schemas/src/index.ts` directly: confirmed `tenantId`/`supplierId` fields exist on `TransactionEvent` exactly as described.
- Spot-checked `packages/database/src/repositories/webhook-endpoints.ts` directly: confirmed `findByAppId`/`findActiveByAppId` were fully removed (not just bypassed) in favor of `findByAppAndTenant`/`findActiveByAppAndTenant`.
- Spot-checked `packages/database/src/supplier-scope.ts` directly: confirmed it is now an exported `SupplierScope` class, no longer dead code importing its own package.

**Process note worth preserving:** the implementing agent accidentally deleted the refund amount/status checks while editing the refund route — an existing test caught this immediately, and the agent fixed it before reporting completion. This is kept in the register as concrete evidence that the accumulated test suite built across Phases 2-7 is doing genuine regression-catching work, not merely accumulating a green checkmark count.

**A significant new architectural finding was surfaced during this phase, not yet fixed:**

### PHASE7-01 (NEW, OPEN — pre-existing at HEAD, newly discovered). The EventBus publishes to Redis but nothing subscribes to the channel
- **Finding:** in a real multi-process deployment (a separate gateway process and worker process, which is the platform's actual intended production topology), events emitted by the worker (payment webhook outcomes, outbox-dispatched events, message delivery, etc.) are published to a Redis channel that **no process is actually subscribed to** — meaning they never reach the gateway's own webhook-dispatch subscriber, which only ever sees events emitted within its own process. All of Phases 2-7's extensive testing has run correctly within a single test process, where this gap is invisible, since the in-process EventBus delivers synchronously to local listeners regardless of the Redis pub/sub path.
- **Severity:** this is potentially a significant real-world correctness gap given the platform's actual two-process (gateway + worker) deployment topology — if confirmed in production, it would mean **no worker-originated event (including payment webhook confirmations) ever reaches a merchant's registered webhook endpoint at all**, since dispatch only happens gateway-side and the gateway never receives the worker's events over Redis.
- **Status:** OPEN — not fixed in this phase (correctly out of scope; discovered as a byproduct, not something the agent was asked to look for), flagged with high priority for an early future phase (likely Phase 11-12 or a dedicated EventBus-correctness pass) given its potential severity. **This finding needs confirmation and prioritization before any claim of "payment webhooks reach merchants in production" can be made** — Phases 2-7's fixes to the webhook/outbox/reconciliation pipeline are all real and independently verified, but this finding means the pipeline's final hop (gateway process actually dispatching to the merchant) may not function across real process boundaries at all.

**Other honest residual findings, disclosed by the implementing agent and preserved here:**
- Status lookup and refunds still consult the in-memory event history as their primary record (C17's original finding) — now correctly tenant-scoped and cross-checked against the durable `transactions` row for refunds specifically, but still don't survive a gateway restart or work consistently across multiple gateway instances. Tracked as a C17 residual.
- `/v1/portal/transactions` still returns every tenant's transactions for an application — portal users are modeled as application-level owners, and there is currently no concept of a tenant-level portal user. Not a regression, just an acknowledged, pre-existing scope boundary of the portal's user model.
- Explicitly confirmed still open, unaddressed by this phase: tenant *status* (e.g. suspended) checks (C18's last bullet), the shared-phone-number conversation misrouting (A1-A3 — still the largest unaddressed P0 category, explicitly next per Phase 8), the single shared admin token with no actor identity (C7), the platform-wide webhook HMAC secret shared across all providers (E10), and test API keys usable for live traffic (C9).
- There are no tenant-facing routes for conversations, audit logs, or metrics at all currently — these remain admin-only and globally scoped, which was out of scope for this phase's focus on tenant-vs-tenant boundaries within existing routes.

**Outstanding BLOCKED items:** Neon-specific verification (proven on stock PostgreSQL 16 via postgres-js only); native per-provider webhook signatures; and — now specifically relevant given PHASE7-01 — genuine multi-process deployment with managed Redis, which is exactly the scenario that would expose the EventBus subscription gap.

**Proceeding to Phase 8 (shared phone number conversation ownership) next**, per the spec's own phase ordering — this is, by the register's own repeated characterization across Sections A, B, and D, the platform's single largest remaining unaddressed category of P0s: the conversation-resolution schema has no column to disambiguate tenants sharing a phone number, the one piece of code that could disambiguate is dead by construction, and an `'ambiguous'` resolution still returns a guessed tenant that the worker acts on — including applying STOP/YES/NO to the wrong tenant.

---

## PHASE 8 — SHARED PHONE NUMBER CONVERSATION OWNERSHIP — COMPLETE

**This phase closed the platform's own explicitly-named critical requirement and the single largest category of unaddressed P0s in the register, spanning Phase 0's Sections A, B, and D.** The conversation model no longer relies on phone+application alone, and "most recent conversation" is no longer usable as an authorization mechanism — genuine ambiguity now results in a durable, operator-resolvable hold rather than a guess, proven with real adversarial scenarios matching the spec's own named examples (shared numbers across Reach Church/HaulPro, STAYSCAPE's two-hotels-one-number case).

**Fixed and independently verified by the orchestrating session:** A1, A2, A3, A4, A5, the A15 conversation-upsert race, and D12.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **784 passed, 0 failed, 149 skipped (933 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/routing/src/conversation-resolver.ts` directly: confirmed the `kind: 'routed' | 'ambiguous' | 'unroutable'` tagged-union return type exists exactly as described — not merely a relabeled `confidence` field, a structurally different return shape that makes the original misuse pattern a compile error.
- Spot-checked `packages/database/drizzle/0017_conversation_ownership_shared_numbers.sql` directly: confirmed the `UNIQUE NULLS NOT DISTINCT (phone_number, business_number, app_id, tenant_id, supplier_id)` constraint and the new `sender_opt_outs` table (number-level STOP, matching real carrier semantics) both exist exactly as described.
- The implementing agent's negative control — temporarily restoring the original resolver and worker and re-running the full adversarial scenario suite, reproducing 16 of 19 failures with messages like "expected 'haulpro' to be 'reach-church'" and "expected 'opted_out' to be undefined" — was reviewed and is exactly the kind of evidence this register requires: proof the fix addresses the documented defect, not just proof the new code passes its own tests.

**Recurring process note:** this is the third phase (after 2 and 7) in which the implementing agent independently discovered and fixed a migration-journal-timestamp ordering trap — `drizzle-kit generate`'s auto-stamped timestamp for a new migration landing earlier than a prior migration's hand-set future timestamp, which would silently skip the new migration forever on any already-migrated database. This is now a well-established, recurring footgun in this codebase's migration tooling specifically (not a defect in any single phase's work) — **any future phase or operator adding a new migration must manually verify its `_journal.json` timestamp is later than every prior entry**, since `drizzle-kit generate` cannot be trusted to get this right automatically here.

**Honest, extensively disclosed residual findings (13 items reported by the implementing agent), preserved here rather than smoothed over:**
1. The number-level STOP block doesn't prevent a candidate tenant reaching the customer via a *different* number or channel before an operator attributes the held message.
2. A STOP arriving with no destination (`To`) number in the webhook is held but cannot be blocked at the number level (no number to block).
3. Held messages get no automated reply (including HELP) from the platform — deliberately, since an automated "which service is this regarding?" reply would require guessing a tenant's consent/billing context (exactly what this phase refuses to guess) and could itself leak which businesses share the number.
4. Messaging adapters still send from their own configured number, not necessarily the registered profile's number — nothing yet enforces the two match, so a misconfigured adapter could cause the platform to record an incorrect sending number.
5. If neither the adapter nor a profile provides a sending number, a conversation is stored without one — still safely routable, never guessed across tenants, but more likely to end up held.
6. A resolved-but-undelivered hold isn't automatically re-enqueued — depends on the same gateway-to-worker queue infrastructure risk already tracked as PHASE7-01/B2.
7. `inbound_message` remains a non-durable job (a pre-existing, separately-tracked gap) — a dead-lettered one isn't automatically re-driven.
8. By the spec's own rule ("exactly one authoritative conversation: ROUTE"), a shared number with exactly one existing conversation still routes to it even if the customer actually meant a different tenant — this is the spec's own accepted tradeoff, not a defect.
9. The number-level mirror of an unambiguous STOP blocks every tenant sharing that number until START — correct carrier-matching behavior, only engaged when `messaging_profiles` shows the number is genuinely shared.
10. Three items explicitly out of this phase's scope, confirmed still open: channel detection beyond a `whatsapp:` prefix (A6), the fail-open tenant-level consent check on DB error (A7), and self-declared/unverifiable operator identity on hold-resolution actions (ties to C7).
11. Pre-existing rows whose number, once normalized, would collide with another are left unnormalized rather than forced — not surfaced to an operator yet.
12. The country tie-breaker map used when a profile doesn't specify a country is small; some number ranges (e.g. +1) are left undetermined rather than guessed.
13. `supplier_id` has no foreign key constraint yet, consistent with the already-tracked D14 finding on free-text/weak-typed tenant identifiers generally.

**Outstanding BLOCKED items:** `UNIQUE NULLS NOT DISTINCT` and `ON CONFLICT` behavior specifically on Neon (proven on stock PostgreSQL 16.15 only, this feature requires Postgres 15+); real provider webhook `From`/`To` payload shapes from Twilio, Africa's Talking, and Infobip specifically (only simulated SignalHouse/Infobip payloads were available to test against); real carrier-level STOP behavior per number (e.g. actual Twilio Advanced Opt-Out semantics, assumed from documentation but not verified against a live account); genuine multi-process deployment (gateway and worker as separate processes against managed Redis — the same scenario PHASE7-01 already flagged as unverified); and migration 0017's behavior at real production data volumes.

**Proceeding to Phase 9 (inbound messaging pipeline + keyword commands) next**, per the spec's own phase ordering — this will verify the full inbound pipeline end-to-end against the new ownership model, and address the keyword-command gaps (CHECK IN, WHERE IS MY DRIVER) and tenant-inappropriate auto-responses (PRAY/HELP wording shown to all tenants) already cataloged in Section A.

---

## PHASE 9 — INBOUND MESSAGING PIPELINE + KEYWORD COMMANDS — COMPLETE

**Fixed and independently verified by the orchestrating session:** A13, in full, plus a significant new defect discovered during the phase.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **840 passed, 0 failed, 161 skipped (1001 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/database/drizzle/0018_keyword_commands.sql` directly: confirmed `keyword_commands` and `keyword_command_dispatches` tables exist exactly as described.
- Spot-checked `packages/workers/src/jobs/inboundMessage.ts` directly: confirmed `keyword_response_delivery` is now genuinely enqueued (it was not before), with a code comment explicitly documenting the prior defect.
- Spot-checked `packages/routing/src/keywords.ts` directly: confirmed PRAY is no longer hardcoded, with a code comment explicitly documenting what the prior behavior was and why it was wrong.

**The most significant finding from this phase was not on the original list:** the keyword-reply delivery job (`keyword_response_delivery`) existed and was registered with the worker, but **nothing in the inbound pipeline ever actually enqueued it** — meaning no customer has ever received an automated HELP or STOP-confirmation reply from this platform as built, at any point before this phase. This is exactly the kind of defect this entire 31-phase engagement exists to find: a capability that appears to exist in the codebase (the job, the handler, the response text) but was never actually wired into the live path. Two compounding bugs were found and fixed in the same pass: the STOP confirmation reply would itself have been blocked by the very opt-out it was confirming, and a reply to an already-opted-out customer would have retried forever instead of resolving as a logged no-op.

**Honest residuals, carried forward from Phase 8 and newly reconfirmed rather than silently resolved:**
- Held messages during genuine shared-number ambiguity still get no automated reply at all, including HELP — Phase 8's own deliberate design choice, unchanged by this phase.
- The audit-log write for STOP/START remains best-effort (not transactionally guaranteed) — an explicit prior Phase 8 test requires this, since the consent/number-level rows are the actual durable record. Flagged as a judgment call appropriate for a future phase to revisit, not resolved either way here.
- `inbound_message` and the reply-delivery job both remain non-durable jobs generally (Phase 8's residual #7) — though the new keyword-dispatch rows specifically are durable and pullable, meaningfully covering the multi-process EventBus gap (PHASE7-01) for app-specific commands even though the general gap remains open.

**Outstanding BLOCKED items:** real carrier behavior (e.g. Twilio Advanced Opt-Out potentially sending its own STOP confirmation and rejecting the platform's, error 21610 — noted as a real risk, not verified); real Twilio/Africa's Talking/Infobip inbound payload shapes; Neon-specific verification (stock Postgres 16 only); genuine multi-process gateway/worker deployment against managed Redis; real webhook delivery across an actual network (only a local HTTP listener was used); production data volumes.

**This closes the last of the shared-number/messaging-focused phases that began with Phase 8.** The payment-correctness phases (2-6) and the tenant/messaging-correctness phases (7-9) have now both been substantially hardened.

---

## PHASE 10 — SILENT CHANNEL FALLBACK OBSERVABILITY — COMPLETE

**Fixed and independently verified by the orchestrating session:** A9 (in full), A6 (send path), A8 (messaging half).

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **864 passed, 0 failed, 166 skipped (1030 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/database/drizzle/0019_channel_decision_audit.sql` directly: confirmed the `chk_events_channel_fallback_reason` CHECK constraint exists exactly as described — a DB-level ban on recording a channel change with no reason, or a reason with no change.
- Spot-checked `packages/routing/src/channel.ts` and `packages/routing/src/index.ts` directly: confirmed the `channel_unavailable` error code exists, and confirmed the old `activeMsg[0]`/`activeMsg.find()` any-channel-picking logic is genuinely gone from `routeMessage` — the remaining `activeMsg` reference is only a global "are any messaging providers online at all" pre-check, with channel-aware selection happening afterward.

**This is a notably strong result: the "never silently change channel" requirement is now enforced at the database schema level**, not merely by application-code discipline — a future code change that tried to silently reintroduce this defect would hit a Postgres constraint violation, not just an unreviewed code path.

**Honest residuals, disclosed by the implementing agent and preserved here:**
- **Messages sent directly through `/v1/api/gateway/messaging` are still never written to the `events` table at all** — a pre-existing gap, not introduced by this phase. The channel decision is fully visible in the response, the emitted event, and tenant webhooks, but not durably persisted for that route specifically. The implementing agent also flagged that persisting them would interact with an existing code comment claiming a plan message-limit count is enforced on this route when it actually isn't — correctly identified as a decision needing deliberate attention rather than an incidental fix, and left for a future phase.
- **Only the Twilio adapter actually reads `payload.channel`** to decide its real wire behavior; Infobip and SignalHouse are simulation-only (E3, already tracked) and ignore it regardless.
- **The inbound half of A6** (a STOP arriving over WhatsApp still defaulting to an `sms`-labeled opt-out) was explicitly out of scope for this phase and remains OPEN.
- **The payments half of A8** (provider override/rule-target bypassing capability/currency/country checks for payments, and the hardcoded `['stripe','nmi','airwallex']` fallback pool) remains OPEN, explicitly deferred to Phase 11-12.
- **A new interaction flagged, not yet a confirmed defect:** an opted-in multi-channel fallback can now take up to `MAX_ROUTING_ATTEMPTS × (1 + number of fallback channels)` provider calls, each individually bounded by `PROVIDER_TIMEOUT_MS` — worth checking against the gateway's overall 60s response timeout (C12, still open) in a future phase rather than assuming it's fine.
- `docs/openapi.yaml` was not updated and continues to document a `/v1/messages` route that doesn't exist in the actual gateway (already tracked as F11).
- The admin-console UI changes (a channel picker, a switch-enable checkbox, a fallback-email field) are type-checked only, not rendered/verified in an actual browser in this pass.

**Outstanding BLOCKED items:** Neon-specific verification (stock Postgres 16 only); real provider channel-handling behavior (does Twilio genuinely send WhatsApp when told to, real carrier behavior); real email delivery to a fallback address; a genuine multi-process gateway/worker deployment.

**Proceeding to Phase 11-12 (provider routing + bounded timeouts) next**, per the spec's own phase ordering — this will address the payments half of A8 deferred above, plus the still-fully-open A10/E4/PHASE3-01 cross-provider double-charge cascade (flattened network-error failure classification triggering a retry on a different provider), which remains the most severe unresolved finding in the payments area of the register.

---

## PHASE 11-12 — PROVIDER ROUTING + BOUNDED TIMEOUTS — COMPLETE

**This phase closed the single most severe unresolved finding in the entire register: a genuine cross-provider double-charge path affecting all 14 payment adapters.** This is a substantive, adapter-by-adapter money-safety fix, not a design nicety — every payment adapter now distinguishes a definite decline (safe to retry elsewhere) from a genuinely ambiguous outcome (never retried, routed into Phase 6's reconciliation path instead), the router's timeout now genuinely cancels in-flight adapter work instead of letting background retries fire unobserved, Stripe's Radar fraud-downgrade no longer leaves a captured charge dangling while reporting failure, and the payments-side capability/currency/country routing gaps deferred from Phase 10 are closed.

**Fixed and independently verified by the orchestrating session:** A10 (in full, with named exceptions below), A8 (payments half, closing the finding in full), E5, E6.

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit` → exit 0, confirmed directly.
- `npx vitest run` → **946 passed, 0 failed, 167 skipped (1113 total)**, confirmed directly, matching the implementing agent's own final figure exactly.
- Spot-checked `packages/providers/src/base.ts` directly: confirmed `isAmbiguousProviderError` and the `'unknown'`-vs-`'failed'` classification logic exist exactly as described.
- Spot-checked `packages/providers/src/adapters/payments/stripe.ts` directly: confirmed the Radar fraud-downgrade path now makes a real `POST /v1/refunds` or `.../cancel` call rather than only changing the reported status.
- Spot-checked `packages/routing/src/index.ts` directly: confirmed `PaymentRouteUnavailableError` exists and the old hardcoded `['stripe','nmi','airwallex']` fallback pool string no longer appears anywhere in the file.

**This phase is held to a higher evidentiary bar than most, given its severity, and the implementing agent met it:** 287 individual negative-control test runs (reverting each of 6 distinct fixes one at a time, confirming specific tests fail, then restoring the file with a SHA-256 check) — the most extensive negative-control regime of any phase so far.

**Honest, explicitly named lowest-confidence items — these are not glossed over, and must be prioritized in Phase 27:**
- The exact classification of several provider-specific error/result codes is based on the implementing agent's knowledge of each provider's public documentation, with **no live provider account or sandbox available in this sandbox to verify against**: Authorize.Net's "processing error" code list, NMI's result codes 420/421/430, Braintree's GraphQL error class names, Adyen's error code 704, and whether Airwallex/PayChangu/Flutterwave genuinely replay a result for a repeated idempotency key (assumed not to, which is the conservative/safe assumption but unverified).
- Paystack is deliberately kept classifying every failure as a definite decline rather than ambiguous — a considered design decision, not an oversight: Paystack's initialize call only creates a checkout page and moves no money itself, so a lost response there cannot represent an already-processed charge the way it could for the other 13 adapters.
- A noted edge case in Stripe's own reconciliation query (built in Phase 6): it reads only the payment intent's status, so a payment intent that was refunded *after* a Radar block (now correctly reversed by this phase's E5 fix) would still be reported as `succeeded` by a reconciliation status check, since the query doesn't currently distinguish "succeeded and never touched again" from "succeeded, then reversed." Flagged for a future refinement of the reconciliation query, not a fix made in this pass.

**New findings surfaced during remediation, added to the register:**

### PHASE11-01 (NEW, OPEN). Whether a fraud-blocked payment should be retried on another provider at all remains an open policy question, even after the money-safety fix
- **Finding:** E5's fix ensures a Radar-flagged charge is correctly reversed before the router moves to a second provider — but the router still *does* move to a second provider for a fraud block, same as any other definite decline. Whether retrying a payment instrument that one provider's fraud system specifically flagged as high-risk, on a *different* provider/acquirer, is itself a sound business/risk policy was explicitly not addressed by this phase.
- **Severity:** P1 (business/fraud-risk policy question, not a money-safety defect — the dangling-charge defect itself is fixed)
- **Status:** OPEN — flagged for product/risk-policy input, likely alongside future provider-adapter-contract work (Phase 26).

### PHASE11-02 (confirms and formalizes a note from A10/E5). Fraud-blocked/hard-declined charges retried elsewhere with no decline-code-aware classification
- **Status:** OPEN — carried forward from A10's original finding, explicitly not addressed by this phase's ambiguous-vs-definite classification fix (a fraud block is a definite decline, correctly not retried as `'unknown'` — the open question is whether it should be retried as a decline at all, per PHASE11-01).

**Also noted by the implementing agent, not a defect:** running the test suite with `REDIS_URL` set (rather than unset) causes 3 unrelated Phase 8 shared-number messaging tests to fail — confirmed by the implementing agent to be a pre-existing baseline condition unaffected by this phase's own changes, not something this phase introduced or needs to fix. Worth a note for whichever future phase next touches the Phase 8 shared-number test suite's environment assumptions.

**Outstanding BLOCKED items:** no real provider sandbox credentials were available for any of the 14 adapters — every classification decision above is built from documented API knowledge, not verified against a live account; stock PostgreSQL 16 only (no Neon-specific verification); no multi-process deployment; `fetch` was stubbed throughout, no real network sockets exercised.

---

## PHASE 13 — WORKER RELIABILITY — COMPLETE

All three findings carried forward from Phase 0's original inventory (B6, B7, and the contention half of B15) are confirmed real, fixed, and proven with negative controls. All three live entirely in the Redis/KVStore job layer (`packages/workers/src`), not Postgres — there is no new migration this phase.

**Fixed and independently verified by the orchestrating session:** B6 (in full), B7 (in full), B15 (contention behavior only — lease renewal/fencing explicitly not addressed, see PHASE13-05).

**Verification performed directly by the orchestrating session:**
- `npx tsc --noEmit -p tsconfig.json` → exit 0, confirmed directly.
- `npx vitest run` → **966 passed, 0 failed, 167 skipped (1133 total)**, confirmed directly, matching the implementing agent's own final figure exactly (+20 over Phase 11-12's 946, exactly the size of the new test file).
- Spot-checked `packages/workers/src/queue.ts` directly: confirmed `promoteDelayed`'s `zrem`-as-claim fix and `rescueStuckJobs`'s new `releaseAbandonedClaim` call exist exactly as described.
- Spot-checked `packages/workers/src/lock.ts` directly, in full: confirmed `LockNotAcquiredError`, `acquireWithWait`, `tryWithLock`, and `withLock`'s new bounded-wait-then-throw behavior exist exactly as described.
- Ran the new `packages/workers/src/worker-reliability.test.ts` in isolation: **20/20 passing**, with real-Redis log lines visible in the output (`[worker] rescued 1 orphaned processing job(s) on startup`, `[provider_health] skipped p1: another health check holds the provider lock`, `[reconciliation] skipped: another reconciliation run holds the lock`) — confirming the tests exercise a real Redis server, not only an in-memory double.
- **Independently reproduced the original B7 defect as its own negative control**, rather than only trusting the implementing agent's report of it: reverted `promoteDelayed` to the pre-fix (return-value-ignored) form, re-ran the concurrent-promoters test, got `expected 100 to be 20` (every one of 20 due jobs pushed onto the ready list 5 times instead of once) — the identical failure the implementing agent reported. Restored the fix and confirmed the restored file's SHA-256 (`ee99b9d1...4171`) matched the pre-revert fix byte-for-byte; all 20 tests in the file passed again.
- Did not independently re-run the implementing agent's B6 and B15 negative controls (direct code inspection plus the B7 reproduction above were judged sufficient corroboration of the agent's described methodology, which matched the pattern used successfully in every prior phase).

**Why no `*.postgres.integration.test.ts` variant this phase:** none of B6/B7/B15 touch Postgres locking — all three bugs and fixes live in the Redis/KVStore job queue. The implementing agent did re-run every existing Postgres-backed suite (including `payment-reconciliation.postgres.integration.test.ts`, whose hand-written lock mock needed a `tryWithLock` addition since `reconciliation.ts` now calls it) against a real local Postgres 16.15 with no regressions: 1121 passed / 0 failed / 12 skipped, up from 1101 before (the same +20).

**New findings surfaced during remediation, added to the register:**

### PHASE13-01. `rescueStuckJobs` has the same unclaimed-race shape B7 had
- **Status:** OPEN — filed under B10 above (the reaper-territory finding this belongs to), not fixed this phase. See B10's updated entry for detail.

### PHASE13-02 (NEW, OPEN). MemoryStore and RedisStore disagree on same-owner lock re-acquisition
- **Finding:** `RedisStore`'s `SET NX` correctly refuses to let the same owner re-acquire a lock it already holds (returns false); `MemoryStore`'s `acquireLock` incorrectly returns true and extends the TTL for a same-owner re-acquire. Probed directly by the implementing agent: `memory.sameOwnerAgain=true`, `redis.sameOwnerAgain=false`. A test written only against MemoryStore could therefore pass in CI while the equivalent production (Redis) behavior would not. Current callers all generate a random owner id per invocation, so this has no live production effect today — but the test double and the real store silently diverge, which risks a future false-positive test.
- **Severity:** P2
- **Status:** OPEN — not fixed this phase (fixing `MemoryStore` to match Redis semantics is the correct direction; deferred as a test-infrastructure fix rather than a production defect).

### PHASE13-03 (NEW, OPEN). Deploy-window residual on the B6 fix
- **Finding:** idempotency claims written before this fix ships carry no `ownerJobId` field, so the reaper's new `releaseAbandonedClaim` cannot release them (it checks ownership before deleting). A job that crashes during the rolling deploy that ships this fix can still hit the original B6 failure mode once, until that specific claim's 24h TTL naturally expires.
- **Severity:** P3 (self-healing within 24h, deploy-window-only, bounded blast radius)
- **Status:** OPEN — acceptable as a one-time deploy artifact; no fix proposed, noted for the deployment runbook (Phase 23-24 territory).

### PHASE13-04 (NEW, OPEN). B6's fix soundness depends on B10's still-open heartbeat gap
- **Finding:** the B6 fix trusts the stale-job reaper's judgment that a crashed job's claim is safe to release. Without a heartbeat (B10, still open), a *live* idempotency-keyed job that happens to run past the reaper's staleness threshold (2-5 minutes, inconsistent per B10's own finding) would be wrongly judged dead, rescued, and now genuinely run a second time — where before this phase's fix it would merely have been skipped (silently dropping the retry, the original B6 behavior). The fix is net-positive but its safety is conditional on B10's eventual resolution.
- **Severity:** P1 (currently low practical risk given short typical job durations, but the dependency is real and should not be forgotten)
- **Status:** OPEN — tracked as a direct dependency for whichever phase resolves B10.

### PHASE13-05 (confirms and narrows B15's original finding). Lock contention fixed; lease renewal and fencing tokens remain absent
- **Status:** OPEN — carried forward from B15's own text, explicitly not addressed by this phase (see B15's updated entry above for the implementing agent's stated risk judgment).

**Outstanding BLOCKED items:** none specific to this phase beyond the general stock-Postgres-only / no-multi-process-deployment caveats already on file from prior phases — this phase's defects and fixes are entirely in-process/Redis-level and were fully exercisable in this sandbox, including against a real spawned Redis server.

**Proceeding to Phase 14 (Redis-backed distributed rate limiting) next**, per the spec's own phase ordering — this will pick up B14 (rate-limiter window never resets under continuous traffic) and B13 (readiness endpoints reporting healthy regardless of the B1 in-memory-fallback condition), both still open from Section B.

**This closes out the payments-correctness work that began in Phase 2.** Phases 2, 3, 5, 6, and now 11-12 together mean: idempotency is DB-constraint-backed, provider identity is deterministic, outbox writes are proven atomic with commit-boundary confirmation, the state machine correctly represents and safely reconciles ambiguous outcomes, and the cross-provider double-charge cascade — the single most severe finding in the register — is closed with adapter-by-adapter rigor. **Proceeding to Phase 13 (worker reliability) next**, per the spec's own phase ordering — this returns to Section B's remaining open findings: B6 (a rescued job with a stuck idempotency claim completes without ever running), B7 (`promoteDelayed()`'s race duplicates retried jobs), and B15 (the distributed lock throws on contention rather than waiting/skipping), none of which have been touched by any phase since Phase 0's original inventory.
