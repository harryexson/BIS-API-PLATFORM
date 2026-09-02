# Service Boundaries

This document defines the exact responsibilities, ownership boundaries, and inter-service contracts for every service in the platform. A service should do exactly what is listed here — no more, no less.

---

## Boundary Principles

1. **A service owns its data**. No service reads directly from another service's database tables.
2. **Communication is explicit**. Services communicate via HTTP API calls or shared database records — never via shared in-process function calls at runtime.
3. **Packages are not services**. `packages/*` are libraries compiled into services. They have no network boundary, no deployment, and no database of their own.
4. **Failure is contained**. If one service crashes, other services degrade gracefully rather than failing completely.

---

## `services/api-gateway`

### Owns
- Request authentication (validates `X-API-Key` header)
- Request rate limiting (per API key, sliding window)
- Request body validation (Zod schemas)
- Request ID generation and propagation
- Routing decision dispatch (delegates to `packages/routing`)
- Response formatting and error normalization
- SSE stream for real-time dashboard updates
- Dashboard management endpoints (`/api/dashboard/*`)

### Does NOT Own
- Provider-specific logic (delegated to `packages/providers` and `providers/*`)
- Webhook reception (owned by `services/webhook-service`)
- Transaction reconciliation (owned by `services/worker`)
- Application/tenant management (owned by `services/application-registry`, planned)

### External API Contract
```
POST /api/gateway/payment
POST /api/gateway/messaging
POST /api/gateway/other
GET  /api/dashboard/providers
PATCH /api/dashboard/providers/:id
GET  /api/dashboard/logs
POST /api/dashboard/logs/clear
GET  /api/dashboard/metrics
GET  /api/dashboard/stream     (SSE)
GET  /health
GET  /ready
```

### Data Owned (writes)
- `transactions` table (creates records, reads its own records)
- `idempotency_keys` table (creates and reads)

### Data Read (does not write)
- `api_keys` table (read-only for auth validation)
- `circuit_breaker_state` table (read-only, written by `packages/resilience`)
- `provider_config` table (read-only, written by admin operations)

---

## `services/webhook-service`

### Owns
- Reception of inbound HTTP webhooks from external providers
- Cryptographic signature verification (per provider)
- Webhook event deduplication
- Webhook event persistence
- Updating transaction status based on webhook payload

### Does NOT Own
- Payment initiation (owned by `services/api-gateway`)
- Provider configuration (owned by `packages/providers` / registry)
- Application routing (owned by `services/api-gateway`)

### External API Contract
```
POST /webhooks/stripe
POST /webhooks/flutterwave
POST /webhooks/pawapay
POST /webhooks/paychangu
POST /webhooks/airwallex
POST /webhooks/infobip
POST /webhooks/signalhouse
GET  /health
```

### Data Owned (writes)
- `webhook_events` table (creates records with full raw payload)
- `transactions` table (updates `status`, `settled_at` based on webhook outcome)

---

## `services/worker`

### Owns
- Background reconciliation of `pending` transactions older than configured threshold
- Querying provider APIs to determine transaction outcomes
- Marking stale transactions as `failed` or `success` after reconciliation
- Cleanup of expired `idempotency_keys` records
- Circuit breaker state evaluation (marks providers healthy after recovery window)

### Does NOT Own
- Inbound request handling (no HTTP server — runs on a timer)
- Payment initiation

### Schedule
- Transaction reconciliation: every 5 minutes
- Idempotency key cleanup: every 24 hours
- Circuit breaker evaluation: every 2 minutes

---

## `apps/admin-console`

### Owns
- Dashboard UI rendering
- SSE connection to `services/api-gateway`
- Displaying provider health, metrics, logs, and topology
- Provider configuration UI (calls `PATCH /api/dashboard/providers/:id`)
- Request playground (calls `POST /api/gateway/*`)

### Does NOT Own
- Any business logic
- Direct database access (all data via HTTP from `services/api-gateway`)
- Authentication management (reads API key from local env only)

---

## Stub Services (Future Microservice Boundaries)

These services are scaffolded but not yet independently deployed. Their logic currently lives inside `services/api-gateway` and `packages/*`. They are separated here to define the intended future boundary.

### `services/orchestration-engine`
**Future responsibility**: Receives raw client requests and orchestrates multi-step workflows (e.g., verify identity → then charge payment → then send receipt). Currently, `services/api-gateway` handles this inline.

### `services/payment-router`
**Future responsibility**: Standalone routing decision service — determines which provider to use for a payment given rules, weights, circuit state, and request context. Returns a routing decision without executing it. Currently embedded in `packages/routing`.

### `services/messaging-router`
**Future responsibility**: Same as `services/payment-router` but for messaging channels.

### `services/provider-registry`
**Future responsibility**: Source of truth for provider configuration, health status, and routing weights. Exposes an API for querying and updating provider state. Currently in-memory within `packages/providers`.

### `services/application-registry`
**Future responsibility**: Manages API keys, client application metadata, rate limit policies, and tenant configuration. Currently hardcoded in `packages/shared`.

---

## Inter-Service Communication Matrix

| From → To | Method | Protocol | Auth |
|-----------|--------|----------|------|
| Client App → api-gateway | Synchronous | HTTPS | X-API-Key |
| api-gateway → packages/* | In-process | Function call | N/A |
| Provider → webhook-service | Synchronous (inbound) | HTTPS | HMAC signature |
| webhook-service → DB | Direct | Prisma | DB credential |
| worker → DB | Direct | Prisma | DB credential |
| worker → Provider APIs | Synchronous | HTTPS | Provider API key |
| admin-console → api-gateway | Synchronous | HTTPS/SSE | X-API-Key |
