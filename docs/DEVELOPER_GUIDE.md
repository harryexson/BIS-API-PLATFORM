# Developer Guide — BIS API Platform

This guide explains how to integrate with the BIS API Platform gateway.
The authoritative machine-readable contract is [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1) — this guide and that spec were reconciled with the real
implementation (`services/api-gateway/src/app.ts`) together on 2026-09-17;
if they ever drift again, `openapi.yaml` is the one to trust first.

## 1. Base URLs

| Environment | Base URL |
|-------------|----------|
| Production  | `https://api.company.com` |
| Sandbox     | `https://sandbox.api.company.com` |

Every gateway route lives under `/v1/api/...` on top of the base URL above
(e.g. `POST https://api.company.com/v1/api/gateway/payment`) — `/health` and
`/ready` are the only exceptions, at the domain root with no `/v1` prefix.

Use **sandbox** with `sk_test_...` keys for all development and testing.
Providers without real credentials configured (`GET /v1/api/gateway/
providers`'s `configured: false`) fall back to labeled simulated
processing automatically, so you can exercise most flows without real
money — the sandbox is not a separate simulated backend, just a
convention for which keys/credentials you use against the same gateway.

## 2. Authentication (API keys)

Every `/v1/api/gateway/*` and `/v1/api/webhooks/*` route requires a valid
API key as a Bearer token — `/health` and `/ready` are the only
unauthenticated routes:

```http
Authorization: Bearer sk_live_xxxxxxxxxxxx
```

Keys are:

- **Issued per application.** The application is resolved entirely from
  the key — there is no separate `app_id` request field to set or spoof;
  if you send one in a request body, it is silently overwritten with the
  key's own application before the request is processed.
- **Optionally scoped.** A key may be restricted to specific scopes (e.g.
  `payments:send`, `messaging:send`, `transactions:read`,
  `providers:read`) — a key with no scopes configured is unrestricted. A
  scope mismatch returns `403`, not `401`.
- **Secret.** Treat them like passwords. They are never returned by any
  API endpoint; provider secret metadata is always masked (e.g.
  `sk_live_••••1234`).

Every `/v1/api/gateway/*` route also requires an `x-tenant-id` header,
validated against the authenticated application's linked tenants — missing
returns `400`, a tenant not linked to this application returns `403`. This
is unrelated to API-key scoping; both checks apply independently.

Rotate keys from the admin console. On rotation, the old key stops working
immediately.

## 3. Request tracing

Every response includes an `X-Request-Id` header (a UUID generated per
request) — include it in support tickets. There is no `X-Correlation-Id`
*response* header: you may send one as a *request* header for this
gateway's own internal log correlation, but it is not echoed back or
attached to anything you can query later.

## 4. Idempotency

Only `POST /v1/api/gateway/payment` supports idempotency today — refunds
and messages do not. Send an `x-idempotency-key` header (note the header
name: `x-idempotency-key`, not `Idempotency-Key`):

```http
x-idempotency-key: 8b1f8c2e-3a9d-4c7b-9e21-5f1a2b3c4d5e
```

Replaying the same key within a 5-minute window returns the original
cached response with no new provider call. There is no conflict-detection
behavior — a reused key always returns the original cached result,
regardless of whether the new request's payload differs. If you omit the
header, no idempotency protection applies to that request at all — always
set your own key for anything that must not double-charge on retry.

## 5. Errors

Every error is a **flat** envelope — no nested object, no machine-readable
code, no request-id echo field:

```json
{ "error": "Missing parameter: amount is required" }
```

Log the response body itself for debugging; correlate with `X-Request-Id`
from the response headers (see §3) if you need to reference a specific
request.

## 6. Pagination

There is no pagination on any route today. `GET /v1/api/gateway/providers`
returns every matching provider in one response; there is no `limit` or
`cursor` parameter.

## 7. Payments & refunds

### Create a payment

```http
POST /v1/api/gateway/payment
Authorization: Bearer sk_live_xxx
x-tenant-id: ten_reach_church
x-idempotency-key: <uuid>
Content-Type: application/json

{
  "amount": 49.99,
  "currency": "USD",
  "paymentMethod": "card",
  "paymentToken": "pm_card_visa"
}
```

`amount` is in the currency's **major** unit (e.g. `49.99` for $49.99), not
cents. `paymentToken` is a client-side-tokenized payment instrument (e.g.
via Stripe.js) — the gateway never collects raw card data; without one,
card-based providers fall back to simulated processing.

For **card** payments the response `status` is typically `success`/`failed`
synchronously (HTTP `200`). For **mobile money** (`paymentMethod:
"mobile_money"`, providers PawaPay/PayChangu) the initial `status` is
often `unknown` (HTTP `202`) — genuinely unresolved, not a fabricated
guess — with final settlement delivered via webhook. Poll
`GET /v1/api/gateway/transaction/{id}` to check.

### Refunds

`POST /v1/api/gateway/refund` refunds a transaction this application owns.
`transactionId` is the `id` field from the original payment response —
this platform's internal database id is never exposed to callers. Only a
transaction currently `success` can be refunded. Omit `amount` for a full
refund, or supply it for a partial refund:

```http
POST /v1/api/gateway/refund
Authorization: Bearer sk_live_xxx
x-tenant-id: ten_reach_church
Content-Type: application/json

{ "transactionId": "pi_3MtwBwLkdIwHu7ix28a3tqPa", "reason": "customer_requested" }
```

Real refund support (verified against each provider's own API) exists for
**Stripe, NMI, and Flutterwave**. Any other provider returns
`status: "failed"` with an explanatory error — refunds are never
fabricated for a provider whose real refund API hasn't been integrated.

## 8. Messages

```http
POST /v1/api/gateway/messaging
Authorization: Bearer sk_live_xxx
x-tenant-id: ten_reach_church

{ "recipient": "+265888000111", "content": "Confirmed." }
```

The channel (SMS, WhatsApp, email) is determined by which provider handles
the request, not a `channel` field you set — use `providerOverride` (e.g.
`"email"`) to target a specific provider directly.

There is no read API for an individual message or a conversation thread
today. The only status-check route is
`GET /v1/api/gateway/transaction/{id}` (see §7), and it only covers a
gateway process's own recent in-memory history, not a durable, queryable
message log.

## 9. Webhooks

There are **two** webhook directions:

### 9a. Inbound provider webhooks (platform receives)

Providers call `POST /v1/api/webhooks/{provider}` (e.g.
`/v1/api/webhooks/stripe`). These are **not** authenticated by your API key.
The gateway verifies each delivery in one of two ways, in this order:

1. **Native, provider-specific verification** — when the adapter for that
   provider implements `verifyProviderWebhookSignature()`
   (`BaseProvider`/each adapter in `packages/providers/src/adapters/
   payments/*.ts`) *and* its own webhook secret is configured, the delivery
   is checked against that provider's own real signature scheme: Stripe's
   `Stripe-Signature` (`t=`/`v1=` HMAC-SHA256, 300s replay window), NMI's
   `Webhook-Signature` (`t=`/`s=`, nonce-keyed HMAC-SHA256), Flutterwave's
   `verif-hash` (a static configured value, not a computed HMAC), PayChangu's
   `Signature` (plain HMAC-SHA256), or Airwallex's `x-timestamp`/
   `x-signature` (HMAC-SHA256 of the concatenated timestamp+body). Once a
   native check is available it is authoritative — failing it rejects the
   delivery outright and never falls through to step 2.
2. **Generic platform fallback** — used only when no native scheme applies
   (the adapter has none, or its webhook secret isn't configured): an
   `x-webhook-signature` header holding an HMAC-SHA256 of the raw request
   body, keyed by this platform's own `WEBHOOK_HMAC_SECRET`.

**PawaPay is the one remaining gap**: its real scheme is RFC-9421 HTTP
Message Signatures (asymmetric, keyed by PawaPay's own published public key,
with its own canonicalization rules) — deliberately not implemented, since a
wrong implementation of an asymmetric scheme would silently degrade
security rather than honestly fall back. PawaPay webhooks are verified via
the generic platform fallback only. See
`packages/providers/src/adapters/payments/pawapay.ts` and
`docs/providers/ADDING_A_PROVIDER.md` §6 for detail, including how to add a
native check for a new adapter.

The raw body is verified **before** parsing. Deliveries are deduplicated
in-memory at the gateway by the payload's own `id` field (a 5-minute
window) and, independently, by the worker that processes the enqueued job
(a durable, longer-lived idempotency key). You do not call this endpoint
yourself.

### 9b. Outbound platform webhooks (you receive)

Register a callback URL and this platform will POST every event your
application generates — payments, refunds, messages — to it as it happens,
signed so you can verify it really came from here. This closed 2026-09-17;
see `docs/IMPLEMENTATION_BASELINE.md` item 24 for the history (the retry
engine existed for a while before anything could reach it).

#### Register an endpoint

```http
POST /v1/api/gateway/webhooks
Authorization: Bearer sk_live_xxx
x-tenant-id: ten_reach_church
Content-Type: application/json

{ "url": "https://your-app.example.com/webhooks/company", "events": ["payment"] }
```

`events` is optional — omit it (or pass `["*"]`) to receive every category
(`payment`, `messaging`, `other`). The response includes a `secret`
(`whsec_...`) — **shown exactly once, here.** Store it now; it's never
re-displayed by `GET`, only used server-side to sign each delivery.

```json
{ "id": "...", "url": "...", "events": ["payment"], "active": true, "createdAt": "...", "secret": "whsec_..." }
```

`url` must be `https://` (plain `http://` is only accepted outside
production, for local testing). `GET /v1/api/gateway/webhooks` lists your
own endpoints (no secret); `DELETE /v1/api/gateway/webhooks/{id}` removes
one — both scoped to the authenticated application, so you can never see
or delete another application's registration.

#### What you receive

Each delivery is a `POST` of the **raw `TransactionEvent` itself** — the
same shape `POST /v1/api/gateway/payment`/`/refund`/`/messaging` return
synchronously — not a separate `{id, object, type, created_at, data}`
envelope:

```http
POST https://your-app.example.com/webhooks/company
Content-Type: application/json
X-Webhook-Id: wh_9f2492b5-de8:pi_3MtwBwLkdIwHu7ix28a3tqPa
X-Webhook-Attempt: 1
X-Webhook-Signature: sha256=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd

{ "id": "pi_3MtwBwLkdIwHu7ix28a3tqPa", "category": "payment", "status": "success", ... }
```

Verify the signature with your registered secret before trusting the body
— `packages/api-client`'s `WebhooksResource` does this for you:

```ts
const event = client.webhooks.constructEvent(rawBody, req.headers['x-webhook-signature'], secret);
```

or by hand: `X-Webhook-Signature` is `sha256=` followed by the hex
`HMAC-SHA256(secret, rawBody)` digest — compute it the same way and
compare with a constant-time check, never `===`.

Delivery retries with exponential backoff (1s, 2s, 4s, 8s, up to 16s) for
up to 5 attempts total before giving up; a non-2xx response or a timeout
counts as a failure. There is no delivery log or manual-replay endpoint
today — if your endpoint was down for all 5 attempts, poll
`GET /v1/api/gateway/transaction/{id}` (§7/§8) to catch up on what you
missed.

## 10. Health

Two separate routes, neither under `/v1` and neither authenticated:

```http
GET /health
```
Trivial liveness check — `200` with `{ status: "healthy", service, timestamp }`
whenever the process is up. No dependency checks.

```http
GET /ready
```
Real dependency check — `200` (`status: "ready"`) or `503`
(`status: "degraded"`) with a `dependencies` object reporting `database`,
`rateLimiter` (`redis`/`in-memory`), `queue` (`healthy`/`unreachable`/
`unconfigured`), and `providers` (always `ready`). Use `/ready` for
uptime/orchestration probes that need to know about a real outage, not
`/health`.

## 11. Quick start (cURL)

```bash
# 1. Create a card payment (sandbox)
curl -X POST https://sandbox.api.company.com/v1/api/gateway/payment \
  -H "Authorization: Bearer $SANDBOX_KEY" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-idempotency-key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "amount":49.99,"currency":"USD","paymentMethod":"card","paymentToken":"pm_card_visa" }'

# 2. List providers
curl https://sandbox.api.company.com/v1/api/gateway/providers \
  -H "Authorization: Bearer $SANDBOX_KEY" \
  -H "x-tenant-id: $TENANT_ID"

# 3. Health check (no auth, no /v1)
curl https://sandbox.api.company.com/ready
```

## 12. SDK & tooling notes

- Serve the interactive docs locally with Redoc or Swagger UI pointing at
  `openapi.yaml`.
- Validate changes with an OpenAPI linter (e.g. `@redocly/cli lint
  docs/openapi.yaml`) before merging.
