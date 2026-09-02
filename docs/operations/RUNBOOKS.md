# Runbooks

## Overview

Step-by-step recovery procedures for known failure modes. Each runbook covers symptoms, immediate actions, escalation, and verification.

**Rule of thumb**: If a runbook does not resolve the issue within 15 minutes, escalate per [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md).

Companion documents:
- [Monitoring Guide](./MONITORING.md) — alert thresholds and log queries
- [Disaster Recovery](../architecture/DISASTER_RECOVERY.md) — RTO/RPO and scenario overviews
- [Deployment Guide](./DEPLOYMENT.md) — deploy and rollback commands

---

## RB-01: API Gateway Unhealthy or Crash Looping

**Symptoms**: `GET /health` returns non-200, Railway shows `CrashLoopBackOff`, uptime alert fired.

**Immediate actions**:
```
1. Check Railway logs for the crash reason:
   railway logs --service api-gateway
2. Common causes and fixes:
   a. DB connection refused (P1001) → check DATABASE_URL env var, Neon status page
   b. Config validation error → check packages/config Zod errors at startup
   c. Missing provider credentials → check startup log for missing env vars
3. If recent deploy introduced the issue:
   railway rollback --service api-gateway
4. If rollback not possible: redeploy from Railway dashboard
5. Watch for crash loop (restart → crash → restart): if persisting > 5 min,
   treat as P2 and escalate
```

**Verification**:
```
curl https://api.company.com/health
# Expected: {"status":"ok","uptime":...,"providers":{...}}
```

**Related**: [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) Scenario 1

---

## RB-02: Database Unreachable / Connection Issues

**Symptoms**: Prisma `P1001` errors in logs, all requests return 503, `db.error_rate` > 0.

**Immediate actions**:
```
1. Check Neon status page: https://neonstatus.com
2. If Neon incident → wait; typically resolved < 15 min. Gateway auto-reconnects.
3. If Neon healthy but platform can't connect:
   a. Verify Neon project is not paused (free tier auto-pauses)
   b. Check DATABASE_URL in Railway — compare to Neon dashboard value
   c. Test connectivity from a shell:
      npx prisma db execute --stdin <<< "SELECT 1"
   d. Rotate DB credentials in Neon, update Railway env var, redeploy
4. If pool exhausted: check `db.connection_pool_usage` — reduce Prisma connection_limit
5. After recovery, trigger reconciliation so pending transactions resolve:
   railway logs --service worker   # confirm worker picks up pending TXs
```

**Verification**: `GET /health` shows healthy DB status; new test transaction succeeds.

**Related**: [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) Scenario 2

---

## RB-03: Provider Circuit Breaker Open

**Symptoms**: `provider.circuit_open` alert, `provider.failure_rate` > 3, `tx.error_rate` elevated for one provider.

**Immediate actions**:
```
1. Identify the provider: SELECT * FROM circuit_breaker_state WHERE state != 'CLOSED';
2. Check provider status page (Stripe status, Flutterwave status, etc.)
3. Confirm the platform is failing over correctly:
   - Check recent transactions for that provider_id — routing should use
     fallback providers automatically (see ROUTING_ARCHITECTURE.md)
4. If provider confirms an incident on their side:
   - Leave circuit OPEN — automatic recovery applies:
     HALF_OPEN at T+120s → probe → CLOSE on success
5. If provider is healthy but circuit is open (bug):
   a. Manually reset: PATCH /api/dashboard/providers/:id → { "status": "online" }
   b. Inspect gateway logs for the 5 failure causes before resetting
6. If failures are caused by a bad config (e.g., wrong API key):
   a. Fix env var in Railway, redeploy
   b. Reset circuit after deploy
```

**Verification**: Circuit state CLOSED, new transactions routing to that provider, `provider.failure_rate` back to 0.

**Related**: [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) Scenario 3

---

## RB-04: All Payment Providers Unavailable

**Symptoms**: `all_providers_unavailable` alert, clients receive 503, dashboard shows all provider circuits OPEN.

**Immediate actions**:
```
1. Confirm it's not a network-level issue: check gateway can reach the internet
   (DNS, egress) — check Railway network logs
2. Check each provider's status page individually
3. If one common dependency (e.g., shared egress IP, TLS trust) is broken:
   - Redeploy gateway (clears any corrupted in-memory state)
   - Verify TLS certs are valid for all provider base URLs
4. If provider credentials rotated recently and services not redeployed:
   - Update env vars → railway redeploy --service api-gateway
5. If a code regression is suspected:
   railway rollback --service api-gateway
6. Consider declaring P1 and opening incident thread per INCIDENT_RESPONSE.md
```

**Verification**: `GET /health` returns providers list with at least one `online`; a test payment succeeds.

---

## RB-05: Transactions Stuck in `pending` (Worker Issue)

**Symptoms**: `tx.pending_stale` alert (> 5 records older than 10 min), mobile money settlements delayed.

**Immediate actions**:
```
1. Confirm worker is running:
   railway logs --service worker
2. If worker crashed → auto-restart; verify it resumes reconciliation
3. Find stale transactions:
   SELECT id, provider_id, amount, currency, created_at
   FROM transactions
   WHERE status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes';
4. Check provider status — if provider is down, wait; worker retries
5. If worker is stuck on a poisoned record (malformed payload):
   a. Identify the record from logs (request_id)
   b. Mark it failed manually ONLY with IC approval:
      UPDATE transactions SET status = 'failed',
        error_code = 'MANUAL_INTERVENTION'
      WHERE id = '<id>' AND status = 'pending';
6. If worker processing is slow (queue backlog): worker is single-instance;
   check for long-running jobs; redeploy worker to restart cleanly
```

**Verification**: Stale count drops to 0, worker log shows completed reconciliation cycles.

---

## RB-06: Webhook Service Down / Webhook Processing Lag

**Symptoms**: `webhook.processing_lag` > 30s, webhook-service health check failing, `webhook.failed_count` > 0.

**Immediate actions**:
```
1. Railway auto-restart — verify recovery:
   railway logs --service webhook-service
2. If crash loop: check for malformed webhook payload crashing the handler
   (faulty provider change) → consider deploy rollback
3. Check `webhook_events` for failed events:
   SELECT id, provider_id, event_type, received_at, error_message
   FROM webhook_events WHERE status = 'failed' ORDER BY received_at DESC;
4. Providers retry webhooks automatically (30–60 min intervals, up to 72h).
   For PawaPay, if outage > 24h, trigger manual reconciliation via worker.
5. If `webhook.signature_failures` > 1: treat as potential attack (RB-09).
```

**Verification**: `webhook.processing_lag` < 30s, new webhooks processed, failed count stops growing.

**Related**: [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) Scenario 4

---

## RB-07: High Error Rate / Latency Spike

**Symptoms**: `tx.error_rate` > 5%, `tx.p95_latency_ms` > 3000ms, `provider.latency_p95` > 5000ms.

**Immediate actions**:
```
1. Determine scope: all providers or one?
   SELECT provider_id, status, COUNT(*) FROM transactions
   WHERE created_at > NOW() - INTERVAL '5 minutes' GROUP BY 1, 2;
2. Check rate limit alerts — possible abuse or a misconfigured client:
   - Identify offending application_id; review its request patterns
   - Contact the client app owner if it's a legitimate spike
3. If single provider slow → routing should fail over; check circuit breaker state
4. If gateway-wide: check DB query latency (`db.query_latency_p95`);
   missing index or lock contention possible
5. If DB is fine: check Railway instance size / CPU throttling;
   consider scaling gateway instances (stateless — safe to scale)
6. If caused by a recent change: `railway rollback --service api-gateway`
```

**Verification**: `tx.error_rate` < 5%, `tx.p95_latency_ms` < 3000ms for 15 consecutive minutes.

---

## RB-08: Webhook Signature Failures (Potential Attack)

**Symptoms**: `webhook.signature_failures` > 1, security alert, repeated 400s on `/webhooks/*`.

**Immediate actions**:
```
1. IMMEDIATELY check rate of failures — if hammering, note source IPs from logs
2. Verify our signing secret matches provider config:
   - STRIPE_WEBHOOK_SECRET, PAYCHANGU_WEBHOOK_SECRET, SIGNALHOUSE_WEBHOOK_SECRET,
     FLUTTERWAVE_SECRET_HASH
3. If secrets were rotated recently on provider side:
   - Update env var → redeploy webhook-service
4. If mismatches are sustained and not explainable:
   - Block offending IPs at platform edge
   - Review webhook_events for any events that succeeded with wrong signatures
     (should be impossible — investigate if found)
   - Open security incident per INCIDENT_RESPONSE.md
```

**Verification**: Signature failures return to 0, no unauthorized events recorded.

---

## RB-09: API Key Compromise / Suspicious Activity

**Symptoms**: Anomalous traffic, unexpected charges, key leaked in a repo/PR, security alert.

**Immediate actions**:
```
1. IMMEDIATE: revoke the key:
   UPDATE api_keys SET revoked_at = NOW() WHERE key_hash = '<hash>';
   # Or revoke via admin dashboard
2. Identify blast radius:
   SELECT * FROM transactions
   WHERE application_id = '<id>' AND created_at > '<suspected_time>';
3. Contact affected payment providers to review/reverse unauthorized charges
4. Issue a new key to the legitimate application owner
5. Review gateway logs for IPs and user agents used during compromise
6. If provider credentials may be exposed:
   - Rotate ALL provider API keys
   - Update Railway env vars
   - Redeploy all services
7. Open security incident (P1) — mandatory postmortem
```

**Verification**: Compromised key rejected (401), new key issued and working, provider rotation complete.

**Related**: [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) Scenario 6

---

## RB-10: Admin Console Down / Degraded

**Symptoms**: `GET /` non-200 for console.company.com, SSE stream not updating, dashboard errors.

**Immediate actions**:
```
1. Check Vercel deployment status; recent deploys may have introduced the issue:
   vercel rollback --token $VERCEL_TOKEN
2. Check VITE_GATEWAY_URL env var — console must point to api.company.com
3. Verify CORS on gateway allows console.company.com (ALLOWED_ORIGINS)
4. If SSE stream is dead but REST works:
   - Check gateway SSE endpoint /api/dashboard/stream directly (curl -N)
   - Check package events EventBus state; redeploy gateway if needed
5. Non-urgent (P3/P4) — dashboard degradation doesn't block payments
```

**Verification**: Console loads (HTTP 200), live transaction feed updates within 5s.

---

## RB-11: Rate Limiting / Client Abuse

**Symptoms**: Clients receive 429, `tx.volume_per_minute` spike, one application_id dominating traffic.

**Immediate actions**:
```
1. Identify the application: SELECT application_id, COUNT(*) FROM transactions
   WHERE created_at > NOW() - INTERVAL '5 minutes' GROUP BY 1 ORDER BY 2 DESC;
2. Determine cause:
   - Client retry loop bug → contact app owner, ask them to fix + back off
   - Intentional abuse → raise rate limit? No — revoke or throttle the key
   - Legitimate launch surge → raise the limit for that app deliberately
3. Adjust rate limit via admin dashboard if supported, else via config
4. Confirm other clients unaffected: error rate by application_id
```

**Verification**: 429s return to normal levels for legitimate clients; offending app constrained.

---

## Runbook Summary Table

| Runbook | Alert / Trigger | First Action | Escalate At |
|---------|-----------------|--------------|-------------|
| RB-01 | Gateway unhealthy | Check Railway logs | 10 min |
| RB-02 | DB P1001 | Check Neon status | 15 min |
| RB-03 | Circuit OPEN | Check provider status | 15 min |
| RB-04 | All providers down | Check provider statuses | 5 min (P1) |
| RB-05 | Stale pending TXs | Check worker logs | 30 min |
| RB-06 | Webhook lag/down | Check webhook-service logs | 30 min |
| RB-07 | Error rate/latency | Scope analysis | 15 min |
| RB-08 | Signature failures | Verify signing secrets | 5 min (security) |
| RB-09 | Key compromise | Revoke key | Immediately (P1) |
| RB-10 | Console down | Vercel rollback | 4 hours (P3) |
| RB-11 | Rate limit abuse | Identify app | 1 hour (P2) |
