# Developer Guide — BIS API Platform (`/v1`)

This guide explains how to integrate with the BIS API Platform public API.
The authoritative machine-readable contract is [`openapi.yaml`](./openapi.yaml)
(OpenAPI 3.1).

## 1. Base URLs

| Environment | Base URL |
|-------------|----------|
| Production  | `https://api.company.com/v1` |
| Sandbox     | `https://sandbox.api.company.com/v1` |

Use **sandbox** with `sk_test_...` keys for all development and testing. The
sandbox simulates provider behavior, including asynchronous mobile-money
settlement, so you can exercise the full webhook flow without real money.

## 2. Authentication (API keys)

Every request (except `/health` and `/webhooks/*`) must carry a valid API key
as a Bearer token:

```http
Authorization: Bearer sk_live_xxxxxxxxxxxx
```

Keys are:

- **Issued per application** (`app_id`). A key is only valid for the `app_id`
  it was issued to. Sending a request with `app_id: app_b` while authenticating
  with a key scoped to `app_a` returns `401 authentication_failed`.
- **Environment-scoped.** `sk_test_...` works only on the sandbox; `sk_live_...`
  only on production.
- **Secret.** Treat them like passwords. They are never returned by any API
  endpoint; provider secret metadata is always masked (e.g. `sk_live_••••1234`).

Rotate keys from the admin console. On rotation, the old key stops working
immediately.

## 3. Request IDs & correlation IDs

Every response includes two tracing headers:

| Header             | Meaning |
|--------------------|---------|
| `X-Request-Id`     | UUID for this specific HTTP request. **Include it in every support ticket.** |
| `X-Correlation-Id` | Logical-operation ID that travels across services **and** into the webhook events derived from the request. |

You may supply your own `X-Correlation-Id` on a request; if you omit it, the
gateway generates one and echoes it back. Use correlation IDs to join a payment
request with its later `payment.succeeded` webhook.

## 4. Idempotency

Network retries must never cause a double charge or a duplicate message. Send an
`Idempotency-Key` header (any UUID/opaque string) on any mutating request
(`POST` to payments, refunds, messages):

```http
Idempotency-Key: 8b1f8c2e-3a9d-4c7b-9e21-5f1a2b3c4d5e
```

Behavior:

- **Replay with the same key and same payload** → the original response is
  returned (status `201`/`202`), no new provider call is made.
- **Replay with the same key but a different payload** → `409
  idempotency_conflict`, and the original resource is returned in
  `error.resource`.
- If you omit the header, the gateway still derives a short-window key (5-minute
  bucket on `app_id + amount + currency`) so a blind network retry of the same
  payment will not double-charge. For longer-lived safety (e.g. your own
  retry queue), always set your own key.

## 5. Errors

All errors use a single envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Missing required field: amount",
    "request_id": "req_1a2b3c4d",
    "correlation_id": "corr_abc123",
    "details": [{ "field": "amount", "issue": "required" }]
  }
}
```

Common `code` values:

| Code | HTTP | Meaning |
|------|------|---------|
| `invalid_request` | 400 | Malformed body / missing field |
| `authentication_failed` | 401 | Missing/invalid/unscope key |
| `not_found` | 404 | Resource does not exist |
| `invalid_operation` | 422 | Valid shape, illegal action (e.g. over-refund) |
| `idempotency_conflict` | 409 | Key reused with a conflicting payload |
| `rate_limited` | 429 | Too many requests; honor `Retry-After` |
| `provider_error` | 503 | Upstream provider failed |
| `internal_error` | 500 | Unexpected platform error |

Always log `error.request_id` — it is the primary key for debugging.

## 6. Pagination

List endpoints (`GET /providers`, `GET /conversations/{id}`) use cursor
pagination:

```http
GET /v1/providers?limit=20&cursor=eyJvZmZzZXQiOjIwfQ==
```

Response wrapper:

```json
{
  "object": "list",
  "data": [ ... ],
  "has_more": true,
  "next_cursor": "eyJvZmZzZXQiOjQwfQ=="
}
```

Pass `next_cursor` as `cursor` on the next call. `limit` defaults to 20 (max
100).

## 7. Payments & refunds

### Create a payment

```http
POST /v1/payments
Authorization: Bearer sk_live_xxx
Idempotency-Key: <uuid>
Content-Type: application/json

{
  "app_id": "app_reachchurch",
  "amount": 4999,
  "currency": "USD",
  "payment_method": "card"
}
```

For **card** payments the response status is `success`/`failed` synchronously.
For **mobile money** (`mobile_money`, providers PawaPay/PayChangu) the
synchronous status is `pending`; final settlement arrives via webhook minutes
later. Poll `GET /v1/payments/{id}` or listen for `payment.succeeded`.

### Refunds

A refund is a **new, immutable** transaction linked to the original via
`payment_id` (the original is never mutated). Omit `amount` for a full refund,
or supply it for a partial refund.

```http
POST /v1/refunds
Authorization: Bearer sk_live_xxx
Idempotency-Key: <uuid>

{ "payment_id": "pay_8f2c1a9b", "reason": "customer_requested" }
```

## 8. Messages & conversations

```http
POST /v1/messages
Authorization: Bearer sk_live_xxx

{ "app_id": "app_reachchurch", "channel": "sms",
  "recipient": "+265888000111", "content": "Confirmed." }
```

Delivery receipts (`message.delivered`, `message.failed`) arrive asynchronously
via webhook. Retrieve a thread with `GET /v1/conversations/{id}`, which returns
the conversation's messages (cursor-paginated).

## 9. Webhooks

There are **two** webhook directions:

### 9a. Inbound provider webhooks (platform receives)

Providers call `POST /v1/webhooks/{provider}` (e.g. `/v1/webhooks/stripe`). These
are authenticated by **provider signature**, not by your API key:

- **Stripe** — `Stripe-Signature` HMAC header.
- **Flutterwave** — `verif-hash` header equality.
- **PayChangu** — `X-PayChangu-Signature` (`sha256=...`) HMAC.
- **PawaPay** — `Authorization: Bearer <JWT>` signed with their key.

The raw body is verified **before** parsing, and each event is deduplicated by
`(provider, provider_event_id)` so duplicates are safe. You do not call this
endpoint yourself.

### 9b. Outbound platform webhooks (you receive)

You register a URL in the admin console. The platform POSTs a `WebhookEvent`
envelope to that URL whenever an async event occurs:

```json
{
  "id": "ev_2f3a4b5c",
  "object": "event",
  "type": "payment.succeeded",
  "created_at": "2026-08-24T12:34:56Z",
  "livemode": true,
  "correlation_id": "corr_abc123",
  "data": { "id": "pay_8f2c1a9b", "object": "payment", "status": "success" }
}
```

**Verify the signature.** Every outbound delivery includes an
`X-Signature` header (HMAC-SHA256 of the raw body with your webhook signing
secret). Reject any request without a valid signature. Return `2xx` quickly
(≤5s); the platform retries with backoff on failure. Use the event `id` as your
own idempotency key to avoid double-processing retries.

Outbound event types: `payment.pending|succeeded|failed`,
`refund.pending|succeeded|failed`,
`message.sent|delivered|failed|undeliverable`.

## 10. Health

```http
GET /v1/health
```

Returns `200` with `status: healthy|degraded` and a `dependencies` block
(`database`, `event_bus`, `providers`). Returns `503` when a critical
dependency is down. Safe to call unauthenticated — use it for uptime probes.

## 11. Quick start (cURL)

```bash
# 1. Create a card payment (sandbox)
curl -X POST https://sandbox.api.company.com/v1/payments \
  -H "Authorization: Bearer $SANDBOX_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "app_id":"app_reachchurch","amount":4999,"currency":"USD","payment_method":"card" }'

# 2. List providers
curl https://sandbox.api.company.com/v1/providers \
  -H "Authorization: Bearer $SANDBOX_KEY"

# 3. Health check
curl https://sandbox.api.company.com/v1/health
```

## 12. SDK & tooling notes

- Serve the interactive docs locally with Redoc or Swagger UI pointing at
  `openapi.yaml`.
- Validate changes with an OpenAPI linter (e.g. `@redocly/cli lint
  docs/openapi.yaml`) before merging.
