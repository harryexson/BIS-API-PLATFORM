# Monitoring Guide

## Overview

This document defines what the platform monitors, the tools used, alert thresholds, and the escalation policy.

---

## What We Monitor

### 1. Service Health
| Check | Endpoint | Frequency | Alert If |
|-------|----------|-----------|----------|
| API Gateway alive | `GET /health` | 30s | HTTP ≠ 200 for 2 consecutive checks |
| API Gateway ready | `GET /ready` | 60s | HTTP ≠ 200 |
| Webhook Service alive | `GET /health` | 30s | HTTP ≠ 200 for 2 consecutive checks |
| Admin Console loads | `GET /` | 60s | HTTP ≠ 200 |

### 2. Transaction Metrics
| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `tx.success_rate` | % of transactions resulting in `success` | < 95% over 5 minutes |
| `tx.error_rate` | % of transactions resulting in `failed` | > 5% over 5 minutes |
| `tx.pending_stale` | Transactions in `pending` > 10 minutes | > 5 records |
| `tx.p95_latency_ms` | 95th percentile end-to-end latency | > 3000ms |
| `tx.volume_per_minute` | Throughput (requests/min) | > 1000 (unexpected spike) |

### 3. Provider Health
| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `provider.circuit_open` | Circuit breaker is OPEN for any provider | Any open circuit |
| `provider.failure_rate` | Consecutive failures per provider | > 3 in 60 seconds |
| `provider.latency_p95` | P95 latency for provider API calls | > 5000ms |

### 4. Database Health
| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `db.connection_pool_usage` | Active connections / max connections | > 80% |
| `db.query_latency_p95` | P95 query execution time | > 500ms |
| `db.error_rate` | Failed queries per minute | > 0 |

### 5. Webhook Processing
| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `webhook.processing_lag` | Time from `received_at` to `processed_at` | > 30 seconds |
| `webhook.failed_count` | Events with `status: failed` | > 0 |
| `webhook.signature_failures` | Invalid signature attempts | > 1 (potential attack) |

---

## Metrics Collection

All metrics are emitted via structured JSON logs and collected by the Railway log drain:

```typescript
// Example structured log in packages/logger
logger.info('transaction.completed', {
  request_id: req.requestId,
  app_id: req.applicationId,
  provider_id: event.providerId,
  status: event.status,
  latency_ms: event.latency,
  amount: event.amount,
  currency: event.currency,
  category: event.category
});
```

### Metrics Pipeline
```
Service → Structured JSON logs
    → Railway Log Drain
        → External log aggregator (Logtail / Better Stack / Datadog)
            → Dashboard + Alerts
```

### Dashboard Panels (Admin Console Built-In)

The admin console provides real-time visibility via the SSE stream:
- Live transaction feed
- Provider health status grid
- Circuit breaker states
- Request rate graph
- Success/failure rate gauge

---

## Alert Configuration

### Alert Channels
- **Slack**: `#platform-alerts` channel (non-critical / warning)
- **PagerDuty / SMS**: On-call engineer (critical / P1)
- **Email**: `platform-ops@company.com` (all alerts, async)

### Alert Severity Levels

| Level | Response Time | Examples |
|-------|---------------|----------|
| P1 Critical | 15 minutes | All providers down, DB unreachable, security incident |
| P2 High | 1 hour | Single provider circuit open, error rate > 10%, latency > 5s |
| P3 Medium | 4 hours | Stale pending transactions, non-critical service degraded |
| P4 Low | Next business day | Webhook processing delay < 2min, single failed webhook |

### Alert Rules

```yaml
# Example: Alert on all-provider failure
- name: all_providers_unavailable
  condition: count(providers WHERE circuit_state = 'OPEN') >= count(providers WHERE category = 'payment')
  severity: P1
  message: "All payment providers are unavailable. Clients are receiving 503."
  channels: [pagerduty, slack]

# Example: Alert on high error rate
- name: high_payment_error_rate
  condition: error_rate > 0.05 over 5min window
  severity: P2
  message: "Payment error rate exceeded 5% in last 5 minutes."
  channels: [slack]

# Example: Alert on stale pending transactions
- name: stale_pending_transactions
  condition: count(transactions WHERE status = 'pending' AND age > '10 minutes') > 5
  severity: P3
  message: "5+ transactions stuck in pending state. Worker may be down."
  channels: [slack]
```

---

## Log Queries (Reference)

### Find all failed transactions in last hour
```sql
SELECT id, app_id, provider_id, created_at, provider_error_code, provider_error_msg
FROM transactions
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

### Find stale pending transactions
```sql
SELECT id, provider_id, amount, currency, created_at,
       EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS age_minutes
FROM transactions
WHERE status = 'pending'
  AND created_at < NOW() - INTERVAL '5 minutes'
ORDER BY created_at ASC;
```

### Find open circuit breakers
```sql
SELECT provider_id, state, failure_count, opened_at
FROM circuit_breaker_state
WHERE state != 'CLOSED'
ORDER BY opened_at DESC;
```

### Find failed webhooks
```sql
SELECT id, provider_id, event_type, received_at, error_message
FROM webhook_events
WHERE status = 'failed'
  AND received_at > NOW() - INTERVAL '24 hours'
ORDER BY received_at DESC;
```

---

## Uptime SLA

| Service | Target Uptime | Max Downtime per Month |
|---------|---------------|----------------------|
| API Gateway | 99.9% | 43.8 minutes |
| Webhook Service | 99.5% | 3.65 hours |
| Admin Console | 99.0% | 7.3 hours |
| Database (Neon) | 99.95% | 21.9 minutes (Neon SLA) |
