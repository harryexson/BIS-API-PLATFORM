# Data Architecture

## Overview

This document defines the data model, persistence strategy, data flows, and data lifecycle for the platform. All persistent state is stored in a single Neon PostgreSQL database accessed via Prisma ORM.

---

## Database Schema

### `applications`
Represents a registered client application that can call the API gateway.

```sql
CREATE TABLE applications (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,          -- "ReachChurch"
  slug        TEXT NOT NULL UNIQUE,          -- "reachchurch"
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `api_keys`
Authentication credentials for client applications.

```sql
CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key_hash       TEXT NOT NULL UNIQUE,       -- SHA-256 of the raw key, never store raw
  prefix         TEXT NOT NULL,              -- First 8 chars for display: "bap_live"
  environment    TEXT NOT NULL DEFAULT 'test', -- 'test' | 'live'
  last_used_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,               -- NULL = never expires
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ               -- NULL = active
);
```

### `transactions`
Immutable record of every payment, message, or API operation routed through the gateway.

```sql
CREATE TABLE transactions (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id       TEXT NOT NULL REFERENCES applications(id),
  category             TEXT NOT NULL,        -- 'payment' | 'messaging' | 'other'
  provider_id          TEXT NOT NULL,        -- 'stripe' | 'infobip' | etc.
  status               TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'success' | 'failed' | 'reconciling'
  idempotency_key      TEXT,                 -- client-provided or generated
  request_id           TEXT NOT NULL,        -- X-Request-ID from gateway
  
  -- Payment fields
  amount               NUMERIC(20, 8),
  currency             TEXT,
  payment_method       TEXT,
  
  -- Messaging fields
  message_type         TEXT,                 -- 'sms' | 'email' | 'whatsapp'
  recipient            TEXT,
  
  -- Provider result
  provider_tx_id       TEXT,                 -- Provider's own transaction ID
  provider_request     JSONB,                -- Full request sent to provider
  provider_response    JSONB,                -- Full response from provider
  provider_error_code  TEXT,
  provider_error_msg   TEXT,
  
  -- Routing metadata
  routing_reason       TEXT,                 -- Why this provider was chosen
  attempts             INTEGER NOT NULL DEFAULT 1,
  latency_ms           INTEGER,
  cost_usd             NUMERIC(20, 10),
  
  -- Timestamps
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at           TIMESTAMPTZ           -- Set when webhook confirms settlement
);

CREATE INDEX idx_transactions_application_id ON transactions(application_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_provider_id ON transactions(provider_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### `idempotency_keys`
Prevents duplicate operations when clients retry requests.

```sql
CREATE TABLE idempotency_keys (
  key            TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  request_hash   TEXT NOT NULL,            -- SHA-256 of normalized request body
  transaction_id TEXT REFERENCES transactions(id),
  response_body  JSONB,                    -- Cached response to return on duplicate
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,     -- 24 hours after creation
  PRIMARY KEY (key, application_id)
);
```

### `webhook_events`
Every inbound webhook from a provider, stored before processing (at-least-once guarantee).

```sql
CREATE TABLE webhook_events (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id        TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,        -- Provider's own event ID (for dedup)
  event_type         TEXT NOT NULL,        -- 'payment_intent.succeeded' etc.
  raw_payload        JSONB NOT NULL,       -- Full raw body exactly as received
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processed' | 'failed' | 'skipped'
  error_message      TEXT,
  transaction_id     TEXT REFERENCES transactions(id),
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  UNIQUE (provider_id, provider_event_id)  -- deduplication index
);
```

### `provider_health`
Time-series health check log for observability and circuit breaker decisions.

```sql
CREATE TABLE provider_health (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   TEXT NOT NULL,
  check_type    TEXT NOT NULL,             -- 'startup' | 'scheduled' | 'on_demand'
  status        TEXT NOT NULL,             -- 'healthy' | 'degraded' | 'unreachable'
  latency_ms    INTEGER,
  error_message TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_provider_health_provider_id ON provider_health(provider_id, checked_at DESC);
```

### `circuit_breaker_state`
Persistent circuit breaker state per provider — survives service restarts.

```sql
CREATE TABLE circuit_breaker_state (
  provider_id        TEXT PRIMARY KEY,
  state              TEXT NOT NULL DEFAULT 'CLOSED', -- 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_failure_at    TIMESTAMPTZ,
  opened_at          TIMESTAMPTZ,
  half_open_at       TIMESTAMPTZ,          -- When to allow probe requests
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Data Flow Diagrams

### Payment Transaction Lifecycle

```
PENDING ──────────────────────────────────────────────────────▶ SUCCESS
   │          Provider responds OK                               (via direct response or webhook)
   │
   ├──── Provider responds ERROR ──────────────────────────────▶ FAILED
   │          (non-retryable or all retries exhausted)
   │
   ├──── No response (timeout/crash) ─────────────────────────▶ RECONCILING
   │          (worker picks up, queries provider)
   │          │
   │          ├── Provider confirms success ─────────────────▶ SUCCESS
   │          └── Provider confirms failure / unknown ───────▶ FAILED
   │
   └──── Max age exceeded (7 days) ────────────────────────────▶ FAILED
              (worker marks stale pending as failed)
```

---

## Data Retention Policy

| Table | Retention | Reason |
|-------|-----------|--------|
| `transactions` | 7 years | Financial audit requirements |
| `webhook_events` | 90 days | Debugging, then archived |
| `idempotency_keys` | 24 hours (TTL) | Duplicate prevention window |
| `provider_health` | 30 days | Trend analysis |
| `circuit_breaker_state` | Indefinite (1 row per provider) | Operational state |
| `api_keys` | Indefinite | Auth history |
| `applications` | Indefinite | Tenant record |

---

## Sensitive Data Handling

| Data | How Stored |
|------|-----------|
| API Keys (raw) | Never stored — hash only (SHA-256) |
| Provider API Keys | Environment variables only — never in DB |
| Payment card numbers | Never received, never stored (providers tokenize) |
| Webhook secrets | Environment variables only |
| PII (recipient emails/phones) | Stored in `transactions.recipient` — to be encrypted at rest (future) |

---

## Backup Strategy

- **Neon** provides automated continuous WAL-based backups
- Point-in-time recovery available to within 30 minutes on paid plan
- `transactions` table is append-only (no hard deletes) — data is never lost by platform code
- Before any migration: `pg_dump` snapshot created and stored in cloud storage
