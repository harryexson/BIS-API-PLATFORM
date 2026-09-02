# Disaster Recovery

## Overview

This document defines the platform's Recovery Time Objective (RTO), Recovery Point Objective (RPO), failure scenario playbooks, and backup/restore procedures.

---

## Recovery Objectives

| Scenario | RTO (Recovery Time) | RPO (Data Loss) |
|----------|---------------------|-----------------|
| Gateway process crash | < 60 seconds | Zero (Railway auto-restarts) |
| Database connection failure | < 30 seconds | Zero (connection pool reconnects) |
| Database service outage (Neon) | < 15 minutes | < 30 minutes (Neon PITR) |
| Webhook service outage | < 5 minutes | Zero (webhooks retried by provider) |
| Provider API outage | < 10 seconds | Zero (routing failover activates) |
| Complete Railway region failure | < 30 minutes | < 1 hour |
| Data corruption | < 2 hours | < 30 minutes (PITR) |
| Security incident / breach | < 4 hours | Varies |

---

## Critical Data

The only data that cannot be reconstructed is:
- `events` table records (transaction and webhook event log)
- `application_api_keys` table (key hashes)
- `applications` table

Provider configurations, circuit breaker state, and health logs are operational data that can be recreated.

---

## Backup Strategy

### Database (Primary Source of Truth)
- **Neon continuous WAL backup**: Automatic, continuous, managed by Neon
- **Point-in-time recovery (PITR)**: 30-minute granularity on paid tier
- **Manual snapshots**: Before every database migration, run:
  ```bash
  pg_dump $DATABASE_URL_UNPOOLED > backup-$(date +%Y%m%d-%H%M%S).sql
  # Upload to cloud storage (e.g., S3 bucket: company-api-platform-backups)
  ```
- **Backup retention**: Automated: 7 days (Neon). Manual: 90 days.

### Application Code
- All code in GitHub — version controlled
- Docker images in GitHub Container Registry (GHCR) — every successful CI build produces a tagged image
- `latest` and SHA tags retained for 30 days

### Secrets / Credentials
- Documented in a team password manager (NOT in version control)
- Each team member has a copy of the `env var inventory` document
- Provider API keys can be regenerated from provider dashboards if lost

---

## Failure Scenario Playbooks

### Scenario 1: API Gateway Crash

**Detection**: Railway health check fails, uptime monitor alerts.

**Impact**: Client apps cannot initiate payments or send messages. In-flight requests at time of crash are lost (client will receive a connection error and should retry).

**Recovery**:
```
1. Railway auto-restart triggers within 10 seconds (configured: restartPolicy: always)
2. If restart loop (crash → restart → crash): check Railway logs immediately
3. Common causes:
   a. DB connection refused → check DATABASE_URL env var, Neon status page
   b. Config validation failed → check packages/config Zod schema errors in logs
   c. Port already in use → unlikely in Railway; check for duplicate deployments
4. Manual recovery: trigger a new deployment from Railway dashboard
5. Verify: curl https://api.company.com/health → {"status":"ok"}
```

**In-flight transactions**: Any event that was in `pending` state at crash time will be reconciled by the worker within 5 minutes.

---

### Scenario 2: Database Outage (Neon)

**Detection**: Neon serverless driver throws connection error. Logged + alerted.

**Impact**: Gateway cannot process any requests (requires DB for auth, idempotency, and transaction recording). Returns 503 to all clients.

**Recovery**:
```
1. Check Neon status page: https://neonstatus.com
2. If Neon incident confirmed: wait for resolution (typically < 15 minutes)
3. If Neon reports healthy but platform cannot connect:
   a. Check DATABASE_URL environment variable in Railway
   b. Verify Neon project is not paused (free tier auto-pauses)
   c. Rotate database credentials in Neon dashboard, update Railway env var
4. After connection restored: gateway auto-reconnects (Neon serverless driver handles reconnection)
5. Verify: GET /health returns healthy DB status
6. Run reconciliation: trigger worker to process any pending transactions
```

---

### Scenario 3: Provider API Outage

**Detection**: Circuit breaker trips for provider (5 consecutive failures). Alert emitted.

**Impact**: Traffic automatically rerouted to fallback providers (see [ROUTING_ARCHITECTURE.md](../architecture/ROUTING_ARCHITECTURE.md)). Client apps may see slower responses (fallback providers may have higher latency).

**Recovery** (automatic):
```
Circuit breaker HALF_OPEN at T+120s → probe request sent to provider
  └── Success → circuit CLOSES → provider re-enters rotation automatically
  └── Failure → circuit stays OPEN → next probe at T+150s
```

**Manual override** (if needed):
```
PATCH /api/dashboard/providers/:id
{ "status": "offline" }  ← force offline, remove from rotation entirely

# When provider is confirmed healthy:
PATCH /api/dashboard/providers/:id
{ "status": "online" }  ← manually restore
```

---

### Scenario 4: Webhook Service Outage

**Detection**: Railway health check for webhook-service fails.

**Impact**: Inbound provider webhooks fail (providers receive 5xx). Providers retry webhooks automatically (usually every 30–60 minutes for up to 72 hours). Mobile money settlements delayed — client apps will see transactions stuck in `pending`.

**Recovery**:
```
1. Railway auto-restarts webhook-service
2. Providers retry missed webhooks automatically (no manual action needed for most)
3. For PawaPay: if outage > 24 hours, manually trigger reconciliation via worker
4. Verify: check `events` table for recently processed webhooks
```

---

### Scenario 5: Data Corruption

**Detection**: Application errors referencing malformed records, or unexpected `failed` transactions for known-good payments.

**Recovery**:
```
1. Identify the time of corruption (check logs for first error)
2. Take a manual DB dump of current state (evidence preservation)
3. Use Neon PITR to restore to 5 minutes before corruption:
   a. Neon Dashboard → Project → Restore
   b. Select restore point
   c. Restore creates a new branch (does not overwrite — safe)
4. Compare restored branch vs current branch to identify affected records
5. Surgically apply corrections (UPDATE statements) rather than full restore if possible
6. Full restore only if corruption is widespread
7. Post-mortem: identify root cause, add validation to prevent recurrence
```

---

### Scenario 6: Security Incident (API Key Compromise)

**Detection**: Anomalous traffic patterns, unexpected charges, security alert.

**Impact**: Depends on scope — compromised key gives access to one application's gateway operations.

**Recovery**:
```
1. IMMEDIATE: Revoke compromised key
   UPDATE application_api_keys SET revoked_at = NOW() WHERE key_hash = '<hash>';
   # Or via admin dashboard if accessible

2. Identify blast radius:
   SELECT * FROM events WHERE application_id = '<id>' AND created_at > '<suspected_compromise_time>';

3. Contact affected payment providers to review / reverse unauthorized charges

4. Issue new API key to legitimate application

5. Review gateway logs for IPs and user agents used during compromise

6. If provider credentials were potentially exposed:
   - Rotate all provider API keys immediately
   - Update Railway env vars
   - Redeploy all services
```

---

## Testing Recovery Procedures

Disaster recovery procedures should be tested:

| Test | Frequency | How |
|------|-----------|-----|
| Gateway crash recovery | Monthly | `railway down` then `railway up` in staging |
| DB failover | Quarterly | Pause Neon project, verify 503, restore, verify recovery |
| Provider failover | Monthly | Set Stripe to `offline` in dashboard, verify NMI takes over |
| Webhook replay | Quarterly | Use Stripe webhook CLI to replay events to staging |
| PITR restore | Bi-annually | Restore Neon staging DB to test point |
