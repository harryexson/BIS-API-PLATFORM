# Disaster Recovery Plan

**Phase:** 46 — Disaster Recovery (verified and corrected in production-remediation Phase 25)
**Status:** Active — every claim below was re-checked against the code on 2026-10-23; see "Verification status"
**Last Updated:** 2026-10-23
**Owner:** Platform Team
**Review Cadence:** Quarterly

---

## Verification status (Phase 25)

Tags used below:

- **[VERIFIED]** — the failure was actually produced in the sandbox (real `redis-server`, real PostgreSQL 16, the real gateway/worker processes or their real classes) and the documented outcome observed. The automated drills are `packages/database/src/backup-restore.postgres.integration.test.ts`, `packages/simulation/src/secret-key-loss-{unrecovered,recovery}.postgres.integration.test.ts` and the Redis-data-loss case in `packages/database/src/webhook-pipeline.postgres.integration.test.ts`.
- **[CORRECTED]** — the previous text was stale or wrong; what is written now is what was observed.
- **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]** — depends on Neon, Railway, S3 or a payment provider, none of which this sandbox can drive.

**This plan has never been exercised against the live service, and the live service cannot run it today (gap register PHASE23-05).** Observed on 2026-10-23: the Railway project `bis-api-platform` has one service, `api-gateway`. There is no `worker` service, so nothing consumes the job queue. There is no Redis. `DATABASE_URL`, `REDIS_URL`, `PORTAL_JWT_SECRET` and `ADMIN_API_CREDENTIALS` are not set, so `/ready` answers 503 and Railway's deploy-time healthcheck fails. The Neon project `bis-api-platform` exists, but its `main` branch has been `archived` (inactive) since 2026-10-21. Every worker, Redis and recovery step below assumes the topology in `docs/operations/DEPLOYMENT.md`. That topology has not been provisioned.

The copies at `/DISASTER_RECOVERY.md` and `docs/architecture/DISASTER_RECOVERY.md` were **not** verified (gap register F12). This document supersedes them.

---

## 1. Recovery Objectives

### RPO (Recovery Point Objective)

**Definition:** The maximum acceptable amount of data loss measured in time. It answers: "How far back in time can we lose data?"

| Component | RPO | Justification |
|-----------|-----|---------------|
| Database (Neon PostgreSQL) | **Seconds, inside Neon's history window; otherwise the age of the last manual dump** | **[CORRECTED]** Neon PITR restores to any point inside the project's history-retention window. It has no "30-minute granularity". The live project's window is **6 hours** (`history_retention_seconds: 21600`, observed 2026-10-23), so corruption found more than 6 h later can only be recovered from a manual `pg_dump` (§3.1). The PITR restore itself is **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**. |
| Redis (job queues) | **Not zero — queued jobs are lost** | **[CORRECTED, VERIFIED]** A Redis restart without persistence drops every queued job. For webhooks that were already acknowledged, `payment_webhook`/`provider_webhook` are rebuilt from Postgres `webhook_events` after `WEBHOOK_STALE_ENQUEUE_MS` (default 10 min). `inbound_message` and every other job type are lost for good (§4.4). |
| EventBus (in-memory) | **Not durable** | **[CORRECTED]** Each process keeps up to 200,000 events / 24 h in memory, not "the last 100". A copy is kept in Redis list `bis:event_history` (24 h TTL). A process restart loses the memory copy; Redis data loss loses the other. The durable records are the Postgres `events`/`transactions` tables. |
| Provider management state | **Same as the database** | **[CORRECTED]** Since Phase 15 it is persisted in Postgres `provider_configs` (`management_config`, plus the encrypted secrets). It is not in-memory only, and it does not reset to code defaults on restart. |
| Application code | **Zero** | Version controlled in GitHub. Always deployable. |

### RTO (Recovery Time Objective)

**Definition:** The maximum acceptable time to restore service after a disaster. It answers: "How quickly can we be back online?"

| Scenario | RTO | RPO |
|----------|-----|-----|
| Gateway process crash | **< 60 seconds** — depends on Railway's restart policy (On Failure, at most 10 restarts) **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]** | Zero |
| Database connection failure | **< 30 seconds** — neon-http opens no persistent connection, so each query succeeds as soon as Neon answers again **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**: the neon-http driver cannot be pointed at a local Postgres | Zero |
| Database service outage (Neon) | **< 15 minutes** **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**. A production worker cannot **start** while the database is unreachable (it exits 1, **[VERIFIED]**), so do not restart workers during the outage. | Zero |
| Worker process crash | **Queued jobs: restart time. The job that was running: up to ~10 min** **[CORRECTED, VERIFIED]** | Zero for queued jobs. The interrupted job runs again from the start, so side effects can repeat (§4.3). |
| Redis outage | **Gateway: automatic, about 30 s after Redis returns. Worker: needs a manual restart.** **[CORRECTED, VERIFIED]** No in-memory fallback activates for a running process. The worker exits about 1 s after Redis drops (§4.3). | Not zero (see the RPO table) |
| Provider API outage | **< 10 seconds** (routing failover). Not re-verified in Phase 25. | Zero (routing failover) |
| Complete Railway region failure | **< 30 minutes** **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**. No alternate region or infrastructure-as-code exists in this repository. | < 1 hour |
| Data corruption | **< 2 hours** **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]** (PITR). The dump-based restore is **[VERIFIED]** (§4.1). | Inside the 6 h PITR window: seconds. Otherwise: the age of the last dump. |
| Security incident | **< 4 hours** | Varies |

---

## 2. Critical Data Inventory

### Irreplaceable Data (Must Survive DR)

| Data | Table | Loss Impact | Backup Method |
|------|-------|-------------|---------------|
| Application registry | `applications` | All clients locked out | Neon WAL + PITR + pg_dump |
| API key hashes | `application_api_keys` | All clients locked out | Neon WAL + PITR + pg_dump |
| Provider registry | `providers` | No provider routing | Neon WAL + PITR + pg_dump |
| Provider configuration + secrets | `provider_configs` (`management_config`; secrets AES-256-GCM in `encrypted_secret`/`secret_iv`/`secret_tag`) | All provider integrations broken | Neon WAL + PITR + pg_dump. The secrets are useless without `SECRET_ENCRYPTION_KEY` (**[VERIFIED]**: a restored row decrypts with the original key only). |
| Tenants + users | `tenants`, `users`, `tenant_application_links` | No multi-tenant ACL | Neon WAL + PITR + pg_dump |
| Transactions + payment idempotency | `transactions`, `idempotency_records` | Payment state lost; duplicate charges possible on client retry | Neon WAL + PITR + pg_dump |
| Durable webhook identity | `webhook_events`, `webhook_event_consumers` | Webhook dedup and the post-Redis-loss recovery sweeper (§4.4) both depend on these | Neon WAL + PITR + pg_dump |
| Merchant webhook outbox | `outbox_events` | Pending/dead-lettered merchant deliveries lost | Neon WAL + PITR + pg_dump |
| Transaction event log | `events` | No reconciliation capability | Neon WAL + PITR + pg_dump |
| RBAC configuration | `roles`, `permissions` | Authorization broken | Neon WAL + PITR + pg_dump |
| Admin audit trail | `audit_logs` | Post-incident forensics lost | Neon WAL + PITR + pg_dump. **[CORRECTED]** It is no longer "historical only": since Phase 20-21 every admin request writes to it, and an admin **write** is refused with 503 `admin_audit_unavailable` if its row cannot be written (**[VERIFIED]** with the database down). No retention policy exists (PHASE20-05): the table grows without bound. How far back the evidence goes depends on Neon's 6 h PITR window and on how old your dumps are. |

### Recoverable Data (Can Be Recreated)

| Data | Table/Store | Recovery Method |
|------|-------------|-----------------|
| Provider health history | `provider_health` | Rebuilt from health check jobs |
| Provider capabilities | `provider_capabilities` | **[CORRECTED]** The application never reads or writes this table: capabilities come from code. |
| Job queue state | Redis | **[CORRECTED]** Not "re-sent by clients/providers". See §4.4 for what comes back and what does not. |
| Worker job idempotency claims | Redis (`IDEMPOTENCY_TTL_HOURS`, default 24 h) | Lost with Redis, so a re-run job can repeat its side effects. **[CORRECTED]** HTTP payment/refund idempotency lives in Postgres `idempotency_records` and survives Redis loss. |
| Rate limit counters | Redis | Reset to zero on Redis data loss (**[VERIFIED]**). During an outage each gateway replica limits from its own in-memory insurance limiter, so limits become per-replica rather than disappearing. |
| Admin auth lockout counters | Redis | Reset on Redis data loss |
| EventBus history | In-memory + Redis `bis:event_history` | Not recoverable. Non-critical; the durable record is Postgres. |

### Encryption Key Dependency

| Key | Purpose | Loss Impact |
|-----|---------|-------------|
| `SECRET_ENCRYPTION_KEY` | AES-256-GCM for `provider_configs.encrypted_secret`, with the key derived by scrypt from this passphrase. Needed by **both** api-gateway and worker. | **All encrypted provider secrets permanently unrecoverable.** Until §4.2 is completed, every provider with persisted secrets is withheld from routing, and `/ready` on gateway and worker answers 503 with `providers: "degraded"` (**[VERIFIED]**). |
| `DATABASE_URL` | Neon connection string | All database access lost |
| `WEBHOOK_HMAC_SECRET` | Signature verification of inbound webhooks (`x-webhook-signature` = hex HMAC-SHA256 of the raw body). The gateway checks it at ingress and the worker checks it again. | **[CORRECTED]** Losing or unsetting it fails **closed**: the gateway answers 503 `NO_WEBHOOK_SECRET` to every webhook, and the worker rejects payment/provider webhook jobs. A **leaked** value is what allows spoofing. It must be identical on both services. |

**CRITICAL:** If `SECRET_ENCRYPTION_KEY` is lost, every provider credential in `provider_configs` must be manually re-entered from provider dashboards. There is no way to decrypt without this key. Re-entry only works in the order given in §4.2 (gap register D13 / PHASE15-04: no admin route discards undecryptable secrets).

---

## 3. Backup Procedures

### 3.1 Database Backup

#### Automated (Neon-managed) — **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**
- **Continuous WAL archiving**: Automatic, no action required.
- **PITR window**: **[CORRECTED]** The live `bis-api-platform` project's window is **6 hours** (`history_retention_seconds: 21600`, observed 2026-10-23), not 30 days. The project also has a 1 GiB branch size limit. A longer window needs a plan change and a project setting.
- **Branch protection**: **[CORRECTED]** The `main` branch has `protected: false`; Neon's protected-branch feature is not in use.

#### Manual (Pre-migration / On-demand) — **[VERIFIED]** against PostgreSQL 16 with this repository's 23 migrations
`DATABASE_URL_UNPOOLED` is Neon's **direct** (non-`-pooler`) connection string. The application never uses it, and it is not in `.env.example`; take it from the Neon console. pg_dump refuses a server newer than itself, and **the live Neon project runs PostgreSQL 18, so use pg_dump 18 or newer** (this sandbox has pg_dump 16, so the dump against Neon itself is **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**).

```bash
set -o pipefail
BACKUP="backup-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL_UNPOOLED" | gzip > "$BACKUP"
```

```bash
# Schema-only snapshot
pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL_UNPOOLED" > "schema-$(date +%Y%m%d-%H%M%S).sql"

# Upload THE SAME file (its name was computed once, above). Bucket name is a placeholder.
aws s3 cp "$BACKUP" s3://company-api-platform-backups/
```

**[CORRECTED]** The previous commands had three defects, each reproduced here:
- `aws s3 cp backup-$(date …).sql.gz` recomputed the timestamp, so the upload named a file that did not exist.
- `pg_dump … | gzip` without `pipefail` exited 0 and left a valid-looking 20-byte `.gz` when pg_dump failed. With `pipefail` the failure is reported, but the truncated file is still left behind: delete `$BACKUP` and do not upload it.
- Without `--no-owner --no-privileges` the dump carries `OWNER TO neondb_owner` (40 statements here). Restoring into any server without that role then fails, or, without `ON_ERROR_STOP`, silently skips those 40 statements and still exits 0.

**What a dump contains (PHASE22-02):** everything in plaintext except provider secrets, which are AES-GCM ciphertext. That includes password and API-key hashes, PII, and raw error text. Some code paths still write unredacted error text into `outbox_events.error`, `webhook_jobs.error`, `webhook_events.last_error`, `webhook_event_consumers.last_error` and `events.error`. A secret that leaked into one of those columns is in every backup taken since, and comes back with every restore (**[VERIFIED]**: the restored copy is byte-identical, leaked text included). These commands do **not** encrypt the file. Encrypt it before upload (e.g. `age -r <recipient>`, or `gpg --encrypt`), or keep it only in a bucket with server-side encryption and tight access control. Store backups apart from `SECRET_ENCRYPTION_KEY`.

#### Backup Schedule
| Type | Frequency | Retention | Storage |
|------|-----------|-----------|---------|
| Neon PITR | Continuous | **6 hours** (observed; plan-dependent) | Neon (automatic) |
| Manual pg_dump | Before each migration. **Not enforced**: `deploy.yml`'s `migrate` job applies migrations to production without taking a dump. | 90 days | S3/GCS (no bucket exists in this repository's configuration) |
| Schema snapshot | Weekly | 90 days | Git commit (the drizzle migrations in `packages/database/drizzle/` are the schema of record) |

### 3.2 Secrets Backup — **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**
```bash
# Railway CLI: `variable list --kv` prints KEY=VALUE (the bare `railway variables` prints a table).
# These are plaintext secrets, so encrypt in the same pipeline instead of writing them to disk.
railway variable list --service api-gateway --kv | age -r <recipient> > railway-api-gateway-$(date +%Y%m%d).env.age
railway variable list --service worker --kv | age -r <recipient> > railway-worker-$(date +%Y%m%d).env.age   # once the worker service exists (PHASE23-05)

# IMPORTANT: Store encrypted in password manager, NOT in version control
```

### 3.3 Code Backup
- **GitHub**: All code version controlled. Repository is the backup.
- **Container images**: **[CORRECTED]** No workflow builds or pushes an image, so there is nothing in GHCR. Railway builds from the GitHub source, and both services start from source (`node --import tsx src/index.ts`).
- **Build artifacts**: `deploy.yml` keeps a `production-build` artifact for 7 days. It is not what Railway runs.

---

## 4. Recovery Procedures

### 4.1 Database Recovery

#### Scenario: Neon Outage — **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**
**Detection**: `DATABASE_URL` connection errors in logs; `/ready` reports `dependencies.database` as `unhealthy`/`unreachable` (503).

**Recovery Steps:**
1. Check Neon status page: `https://neonstatus.com`
2. If Neon incident confirmed: wait for resolution (typically < 15 min). **Do not restart workers meanwhile**: a production worker exits 1 at boot when the database is unreachable (**[VERIFIED]**), and Railway's On-Failure policy stops after 10 restarts. Admin **writes** answer 503 `admin_audit_unavailable` while the database is down (**[VERIFIED]**).
3. If Neon reports healthy but platform cannot connect:
   - Verify `DATABASE_URL` is set on **both** Railway services. On 2026-10-23 it was missing on api-gateway (PHASE23-05).
   - Check whether the branch is archived or the compute suspended. On the free plan the live `main` branch was observed `archived`, and the first connection wakes it.
   - Verify Neon endpoint is running (not suspended)
4. After connection restored: the gateway needs no reconnect (neon-http is stateless HTTPS per query). The gateway's provider-state sync retries by itself.
5. **[CORRECTED]** Verify with `GET /ready`: `dependencies.database` should be `healthy` or `degraded`. `GET /health` reports no database status.
6. **[CORRECTED]** There is no "trigger reconciliation" endpoint. The worker enqueues reconciliation, outbox polling and `webhook_event_recovery` when it starts, then on its timers (`RECONCILIATION_INTERVAL_MS` = 5 min, `WEBHOOK_RECOVERY_INTERVAL_MS` = 30 s). A worker restart after the database is back runs them immediately. Payments still needing an operator are listed at `GET /api/dashboard/payments/reconciliation`.

#### Scenario: Database Corruption
**Detection**: Application errors referencing malformed records, unexpected data state.

**Recovery Steps:**
1. Identify corruption timeframe (check logs for first error)
2. Preserve current state with the §3.1 backup commands (evidence copy).
3. Neon PITR restore — **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**, and **only possible inside the 6-hour window**:
   - Neon Dashboard → Project → Restore
   - Select timestamp 5 minutes before corruption
   - Restore creates a new branch (non-destructive)
4. If the corruption is older than the window, restore the most recent good dump into a **new, empty** database. This is **[VERIFIED]**: the restore exits 0, and the restored database matched the declared schema (Phase 16 drift-guard fingerprint), the source data row for row, and the migration journal (the next `migrate` is a no-op). All CHECKs were validated, and the tenant CHECK, unique and FK constraints were enforced:
   ```bash
   set -o pipefail
   gunzip -c "$BACKUP" | psql -v ON_ERROR_STOP=1 --single-transaction -q "$RESTORE_DATABASE_URL"
   ```
5. Compare restored branch/database vs current
6. Surgical fix preferred: `UPDATE` affected records rather than full restore
7. Full restore only if corruption is widespread. Point `DATABASE_URL` on **both** services at the restored database, and use the **same** `SECRET_ENCRYPTION_KEY` the backup was taken under.
8. Post-mortem: identify root cause, add validation

#### Scenario: Accidental Data Deletion
**Detection**: Missing records, application errors.

**Recovery Steps:**
1. **NEVER** panic-delete or truncate to "fix" the problem
2. Identify exact timestamp and affected tables
3. Neon PITR restore to 1 minute before deletion (only inside the 6 h window, **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**), or restore the last dump into a scratch database (step 4 above)
4. Export needed data from the restored branch/database
5. Import into current branch using `INSERT` statements
6. Verify data integrity

### 4.2 Provider Credential Recovery

#### Scenario: Provider API Keys Lost/Compromised
**Recovery Steps:**
1. **Immediate**: Rotate compromised key at provider dashboard
2. **Update platform** — **[CORRECTED]**: the admin API is the primary path. An adapter reads its env var (e.g. `STRIPE_SECRET_KEY`) **only when no persisted secret exists** for that provider, and `provider_configs` holds ciphertext, so a "direct database update" of a credential is not possible.
   ```bash
   # Persisted credential (upserts by field, encrypts with SECRET_ENCRYPTION_KEY, reaches every replica):
   curl -X POST https://<gateway-domain>/api/dashboard/providers/stripe/secrets \
     -H "x-admin-token: $YOUR_ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"field":"api_key","label":"Secret key","value":"sk_live_NEW_KEY"}'      # → 201, masked

   # Env-var credential (only used when no persisted one exists). Set it on BOTH services;
   # --stdin keeps it out of shell history. `set` triggers a redeploy unless --skip-deploys.
   railway variable set STRIPE_SECRET_KEY --stdin --service api-gateway
   railway variable set STRIPE_SECRET_KEY --stdin --service worker
   ```
   Field names are the ones each adapter reads (Stripe: `api_key`, `webhook_secret`; see `packages/providers/src/adapters/`). `$YOUR_ADMIN_TOKEN` is **your own** named admin token (`ADMIN_API_CREDENTIALS`, Phase 20-21), sent in the `x-admin-token` header. The request is audited under your id.
3. **Verify** — **[CORRECTED]**: `POST /api/dashboard/providers/:id/health-check` does **not** verify a credential. It returns `healthy` for a bogus key and makes no outbound call (**[VERIFIED]**). Verify with `GET /api/dashboard/providers/:id/secrets` (masked list), `/ready` `providers: "ready"`, and a real low-value test-mode transaction or the provider dashboard.

#### Scenario: SECRET_ENCRYPTION_KEY Lost — **[CORRECTED, VERIFIED]** through the real admin routes with a named admin credential against real PostgreSQL
**Impact**: All encrypted `provider_configs.encrypted_secret` values are permanently unrecoverable. Every provider with persisted secrets is withheld from routing, and `/ready` on gateway and worker answers 503 (`providers: "degraded"`).

**Why the order matters (verified):** the registry never overwrites persisted secrets it cannot decrypt (gap register D13), and no admin route discards them (PHASE15-04). Re-entering a credential while the old ciphertext is still there is **refused with 503** ("cannot be decrypted … refusing to overwrite them"). Clearing the rows while the process keeps running does not help either; the process must restart **after** the clear. The redeploy carrying the new key would also fail a `/ready` healthcheck as long as the old rows remain. That Railway-side consequence is **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**.

**Recovery Steps:**
1. Generate new encryption key: `openssl rand -hex 32` (any non-empty passphrase works; scrypt derives the key)
2. **Before deploying it**, clear the undecryptable ciphertext. This keeps each provider's `management_config` (status, weights, routing rules):
   ```sql
   UPDATE provider_configs
   SET encrypted_secret = NULL, secret_iv = NULL, secret_tag = NULL, secrets_version = 0, updated_at = now()
   WHERE environment = 'live' AND encrypted_secret IS NOT NULL;
   ```
   (`'live'` is the production tier; non-production deployments use `'test'`.) Take a §3.1 backup first.
3. Set the new key as `SECRET_ENCRYPTION_KEY` on **both** api-gateway and worker, then redeploy or restart **every** replica of both. Providers that also have an env-var credential (e.g. `STRIPE_SECRET_KEY`) work again from this point.
4. **Manually re-enter every provider credential** through the admin API (`POST /api/dashboard/providers/<id>/secrets` with your own `x-admin-token`, as in the previous scenario; 201 with a masked response):
   - Stripe: `sk_live_...` from Stripe dashboard
   - NMI: API key from NMI gateway
   - Flutterwave: Secret key from Flutterwave dashboard
   - PawaPay: API key from PawaPay dashboard
   - PayChangu: Secret key from PayChangu dashboard
   - Airwallex: Client ID + API key from Airwallex dashboard
   - SignalHouse: API key from SignalHouse dashboard
   - Infobip: API key from Infobip portal
   - FutureSMS: API key from FutureSMS dashboard
5. Verify each provider: the rows are now encrypted under the new key, and a restarted process/the worker loads them (**[VERIFIED]**). Then check `/ready` `providers: "ready"` on both services, the `audit_logs` rows under your admin id, and a real test transaction. **Not** the health-check endpoint (see above).
6. **Estimated recovery time**: 2-4 hours (manual entry of ~15 credentials) **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**

### 4.3 Worker Recovery

**No worker service is deployed on Railway today (PHASE23-05).** Everything below describes the intended topology.

#### Scenario: Worker Process Crash — **[CORRECTED, VERIFIED]** with real processes (SIGKILL mid-job, real Redis)
**Detection**: Worker `/ready` (on `WORKER_HEALTH_PORT`) stops answering or answers 503; job processing stops.

**Recovery Steps:**
1. Railway restarts the worker when it exits non-zero: On Failure policy, at most 10 restarts **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**. A SIGTERM'd worker drains for a full 30 s while still taking new jobs (PHASE23-03), and Railway's default draining time is 0 s (PHASE23-04). Until both are fixed, every deploy is effectively a crash for whatever job is running.
2. If the worker was on an in-memory store (its `/ready` showed `queue: "memory-fallback"`), its jobs are lost.
3. Redis-backed **queued** jobs survive and are processed by the restarted worker (verified: 4 of 4). The job that was **running** stays `processing`. It is re-queued only when a worker **starts** 2 min or more after that job was picked up, or by the running worker's reaper (every `RECONCILIATION_INTERVAL_MS` = 5 min, 5-min threshold), so up to ~10 min. It then runs again **from the start**: in the drill its side effect ran twice. There is no heartbeat (gap register B10, PHASE13-04), concurrent reapers can double-queue a job (PHASE13-01), and messaging jobs carry no idempotency key (B9). Jobs with an idempotency key are re-run correctly (Phase 13's B6 fix).
4. Verify: worker `/ready` → 200 with `queue: "redis"`. Logs show `rescued orphaned processing jobs on startup` when step 3's rescue happens.
5. If restart loop:
   - Check `REDIS_URL` environment variable
   - Check `DATABASE_URL`: in production the worker exits 1 at boot if the database is unreachable (**[VERIFIED]**)
   - Review worker logs for crash reason

#### Scenario: Redis Outage (Worker Impact) — **[CORRECTED, VERIFIED]** against the real worker service process
**Detection**: The worker process **exits** about 1 s after Redis drops: `Error: Redis not connected` escapes the poll loop as an unhandled rejection, exit code 1. It does not fall back to an in-memory store while running.

**Recovery Steps:**
1. Check Redis status (managed Redis dashboard)
2. If Railway restarts the worker while Redis is still down, the worker waits `REDIS_CONNECT_TIMEOUT_MS` (5 s) and then falls back to a private in-memory store. It **stays** there after Redis returns (PHASE19-03, observed: `/ready` 503 with `queue: "memory-fallback"` 12 s after Redis was back, and 0 keys reached the real Redis). It processes nothing the gateway enqueues, and nothing restarts it, because Railway's healthcheck runs only at deploy time (`docs/operations/DEPLOYMENT.md`).
3. Jobs queued in Redis survive an outage only if Redis itself kept them (persistence). For a Redis that came back empty, see §4.4.
4. **When Redis recovers: restart every worker replica manually** and confirm `/ready` shows `queue: "redis"`. Workers do **not** auto-reconnect.
5. Verify: job processing resumes normal throughput

### 4.4 Redis Recovery

**There is no Redis on the live Railway project today (PHASE23-05); `REDIS_URL` is unset.**

#### Scenario: Redis Data Loss (Crash Without Persistence) — **[CORRECTED, VERIFIED]**
**Impact**: All queued jobs, worker idempotency claims, rate limits, admin lockout counters and locks lost (a real `redis-server` restarted with 0 keys).

**Recovery Steps:**
1. **Immediate**: The gateway stays up and reconnects by itself. Its rate limiter and EventBus came back about 2 s after Redis, the job queue within its reconnect backoff (≤ 30 s). Its `/ready` reports Redis-dependent probes as `degraded` and answers 503 once they have been down for `READINESS_GRACE_MS` (default 30 s). **Workers exit and need a manual restart (§4.3).**
2. **Pending jobs**:
   - Payment/provider webhooks that the gateway had **already acknowledged** (200): the provider will **not** retry. A redelivery is answered as a duplicate and enqueues nothing. The worker's `webhook_event_recovery` sweeper re-enqueues `payment_webhook` and `provider_webhook` from Postgres `webhook_events` once a row has been enqueued-but-unconsumed for `WEBHOOK_STALE_ENQUEUE_MS` (default 10 min). Their `inbound_message` job is **not** re-sent.
   - Webhooks the gateway answered with 5xx (enqueue failed) are retried by the provider, or recovered by the same sweeper.
   - Merchant webhook deliveries are in Postgres `outbox_events` and are unaffected.
   - Any other queued job (message delivery, scheduled jobs) is lost; scheduled jobs are re-enqueued by the worker's timers.
3. **Idempotency**: worker job claims are lost, so a re-run job can repeat side effects. Payment/refund HTTP idempotency is in Postgres and unaffected.
4. **Rate limits**: Reset to zero (verified). Brief window where abuse is possible.
5. **Distributed locks**: Lost. TTL-based expiry prevents permanent lock starvation
6. **Verify Redis recovery**:
   ```bash
   redis-cli -u $REDIS_URL PING
   redis-cli -u $REDIS_URL INFO keyspace
   ```
7. **[CORRECTED]** No process logs "Connected to Redis". Verify reconnection through `/ready` on every gateway and worker: `queue: "redis"`, `rateLimiter: "redis"`, `eventBus: "connected"`. The EventBus logs `event bus Redis connected`. Restart any process whose `/ready` shows `memory-fallback`.

#### Scenario: Redis Complete Failure
**Recovery Steps:**
1. If using managed Redis (e.g., Upstash, Redis Cloud):
   - Check provider status page
   - Contact support if prolonged outage
2. If self-hosted:
   - Restart Redis service
   - Check disk space, memory limits
   - Review Redis logs for crash reason
3. After Redis recovers:
   - The gateway reconnects automatically (verified). **Workers must be restarted (verified)**, as must any gateway that was (re)started while Redis was down.
   - New jobs begin queueing normally
   - Lost jobs are recovered only as described in the data-loss scenario above

### 4.5 Webhook Recovery

#### Scenario: Webhook Service Outage
**Detection**: Inbound webhooks return 5xx. **[CORRECTED]** There is no separate webhook service: webhooks are received by api-gateway at `POST /v1/api/webhooks/:provider`.

**Recovery Steps:**
1. Railway restarts the gateway on a non-zero exit **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**
2. Provider webhook retries — **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]** (provider-documented, not verified here):
   - **Stripe**: Retries for up to 3 days with exponential backoff
   - **Flutterwave**: Retries for up to 24 hours
   - **PawaPay**: Retries for up to 72 hours
   - **PayChangu**: Retries for up to 24 hours
3. No manual action needed for webhooks the gateway answered with 5xx. The gateway acknowledges only after the webhook is durably stored in `webhook_events` **and** enqueued (Phase 4), and a redelivery of an acknowledged webhook is a no-op duplicate.
4. **[CORRECTED]** Verify in `webhook_events` (one row per `(provider_id, provider_event_id)`; `enqueued_at`, `status`) and `webhook_event_consumers`, not only `events`.
5. If outage > the provider's retry window: replay from the provider's dashboard (next scenario). There is no worker "reconciliation trigger" for webhooks (§4.1 step 6).

#### Scenario: Webhook Signature Verification Failure
**Detection**: Webhooks rejected with 401 `INVALID_SIGNATURE`/`MISSING_SIGNATURE` (gateway), or payment/provider webhook jobs failing verification (worker).

**Recovery Steps:**
1. **[CORRECTED]** `WEBHOOK_HMAC_SECRET` is the platform's own secret: senders sign the raw body as hex HMAC-SHA256 in `x-webhook-signature`. It is not configured in a provider dashboard. Provider-native schemes (e.g. Stripe's `Stripe-Signature`) are not yet verified on this route, so a provider's own delivery or replay is rejected unless something re-signs it (tracked for Phase 27).
2. It must be identical on **both** services. A gateway mismatch rejects at ingress; a worker mismatch fails and dead-letters the jobs:
   ```bash
   railway variable set WEBHOOK_HMAC_SECRET --stdin --service api-gateway
   railway variable set WEBHOOK_HMAC_SECRET --stdin --service worker
   ```
3. For missed webhooks during outage: use provider dashboard to replay **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]**, subject to step 1:
   - Stripe: `stripe events resend <event_id>`
   - Flutterwave: Dashboard → Webhooks → Replay
4. Verify: process test webhook from each provider

### 4.6 Queue Recovery

Key names are `<WORKER_QUEUE_PREFIX>:queue:<type>:{ready,delayed,dead}` and `<prefix>:job:<id>` (the prefix defaults to `bis`). A worker or gateway whose queue fell back to memory at boot never uses these keys; check `/ready` first (PHASE19-03).

#### Scenario: Queue Corruption (Dead-Letter Queue Full)
**Detection**: Dead-letter queue growing, retry processing failing.

**Recovery Steps:**
1. Check dead-letter queue size:
   ```bash
   redis-cli -u $REDIS_URL LLEN bis:queue:payment_webhook:dead
   redis-cli -u $REDIS_URL LLEN bis:queue:message_delivery:dead
   ```
2. **[CORRECTED]** Re-enqueueing is automatic. The `retry_processing` job (every `RETRY_PROCESSING_INTERVAL_MS`, 30 s) re-queues each dead job as a fresh job, up to `WORKER_MAX_DEAD_RETRIES` (3) times; after that it stays dead permanently. Inspect with `redis-cli -u $REDIS_URL LRANGE bis:queue:payment_webhook:dead 0 -1` and `GET bis:job:<id>` (`lastError`, `deadRetries`).
3. If poison jobs: remove **that** job id:
   ```bash
   redis-cli -u $REDIS_URL LREM bis:queue:payment_webhook:dead 0 <job-id>
   ```
   **[CORRECTED, VERIFIED]** The previous `LTRIM … 0 -100` deleted **every** entry when the list had fewer than 100, and otherwise deleted the 99 **newest** entries indiscriminately (tested: 5 → 0; 150 → the oldest 51 kept). Durable webhook consumers (`payment_webhook`, `provider_webhook`) also record failure in Postgres `webhook_event_consumers`.
4. **[CORRECTED]** There is no retry-counter reset tooling.
5. Verify: dead-letter queue should be empty or near-empty
6. Merchant-webhook (outbox) dead letters live in Postgres, not Redis: `GET /api/dashboard/outbox/dead`, `POST /api/dashboard/outbox/dead/replay`, `POST /api/dashboard/outbox/:id/replay` (admin; not drilled in Phase 25).
7. Jobs stuck in `processing` after a crash are re-queued by the reaper (§4.3 step 3). Phase 13's fixes are in force: a delayed job is promoted exactly once (B7), and a rescued job's abandoned idempotency claim is released (B6).

#### Scenario: Queue Overflow
**Detection**: Queue depth growing faster than processing rate; at `QUEUE_MAX_DEPTH` (default 10,000 ready+delayed per job type) enqueue is refused (`QueueBackpressureError`), which the webhook route answers with 503.

**Recovery Steps:**
1. Check worker concurrency: `WORKER_CONCURRENCY` env var (default 5 per process)
2. Scale workers: increase `WORKER_CONCURRENCY` or add worker instances
3. Check for slow jobs blocking the queue
4. Check Neon write latency (jobs waiting on DB writes)
5. If critical: prioritize payments. **[CORRECTED]** No mechanism exists to pause individual job types.

### 4.7 Application Recovery

#### Scenario: Complete Service Failure (All Services Down)
**Recovery Steps:**
1. Check Railway status: `https://status.railway.app`
2. Check Neon status: `https://neonstatus.com`
3. If infrastructure provider outage: wait for resolution
4. If platform-specific:
   - Check GitHub Actions for recent failed deployments
   - **[CORRECTED]** The Railway CLI has **no** `rollback` command. Roll back in the dashboard: service → Deployments → ⋯ on the last good deployment → Rollback, which restores its image and variables within the plan's image-retention window. Otherwise use `railway redeploy --service api-gateway` or `railway restart --service api-gateway`.
   - Verify `/ready` passes
5. If regional failure — **[BLOCKED — EXTERNAL VERIFICATION REQUIRED]** (no alternate region or infrastructure-as-code exists):
   - Deploy to alternate region (if configured)
   - Update DNS to point to new region
   - Estimated RTO: < 30 minutes

#### Scenario: Complete Data Loss (Nuclear Scenario)
**Recovery Steps:**
1. **Verify Neon backup exists**: Neon Dashboard → Restore (PITR covers only the last **6 hours**). Otherwise use the latest manual dump (§4.1, restore verified).
2. **Restore database**: PITR to last known good state, or restore the dump
3. **Verify SECRET_ENCRYPTION_KEY**: If lost, follow §4.2 in its order
4. **Redeploy all services**: Railway (api-gateway **and** worker — the worker service does not exist yet, PHASE23-05) + Vercel
5. **Verify all integrations**: `/ready` on every service and a real test transaction per provider. The health-check endpoint does not exercise credentials (§4.2).
6. **Estimated RTO**: 2-4 hours (depending on credential recovery)
7. **Estimated RPO**: seconds inside the 6 h PITR window; otherwise the age of the last dump

---

## 5. Recovery Simulation

### Simulation Methodology

Each recovery scenario was simulated by:
1. Identifying the failure condition
2. Executing the documented recovery steps
3. Verifying service restoration
4. Measuring actual RTO vs target RTO
5. Documenting findings and gaps

### Simulation Results

**[CORRECTED]** The previous table reported measured RTOs and PASS results for Railway auto-restart, Neon reconnection, "Redis fallback" and a "tested" Neon PITR restore. None of these was run against real infrastructure. `packages/workers/src/disaster-recovery.test.ts` uses an in-memory store only (gap register F12). The results below are Phase 25's, against real Redis/PostgreSQL processes in the sandbox:

| Scenario | Target RTO | Observed | Result | Notes |
|----------|------------|----------|--------|-------|
| Worker crash (SIGKILL mid-job) | < 60s | Queued jobs: on restart. Running job: re-queued only by a start ≥ 2 min later | **PARTIAL** | Interrupted job ran twice (at-least-once) |
| Redis killed under the worker | < 5 min | Worker exited in ~1 s; restarted while Redis down → stuck on memory fallback after Redis returned | **FAIL** | Manual restart required |
| Redis killed / restarted empty under the gateway | < 5 min | Stayed up; rate limiter + EventBus back ~2 s, queue ≤ 15 s after Redis returned | **PASS** | `/ready` 503 after the grace period while down |
| Redis data loss after a webhook was acknowledged | — | Durable consumers re-enqueued from `webhook_events` once stale | **PASS** | `inbound_message` not recovered |
| Manual pg_dump → psql restore | < 2hr | Seconds (test-sized data) | **PASS** (corrected commands) | Old commands: wrong upload name, masked failures, role errors |
| SECRET_ENCRYPTION_KEY loss → re-entry | < 4hr | — | Old procedure **FAIL** (503); corrected procedure **PASS** | Through real admin routes, named admin credential |
| Gateway crash / Railway auto-restart | < 60s | — | **BLOCKED — EXTERNAL VERIFICATION REQUIRED** | |
| DB connection failure / Neon outage / PITR | < 15min / < 2hr | — | **BLOCKED — EXTERNAL VERIFICATION REQUIRED** | |
| Provider failover | < 10s | — | Not re-verified in Phase 25 | |
| Webhook replay from provider dashboards | < 5min | — | **BLOCKED — EXTERNAL VERIFICATION REQUIRED** | Native provider signatures not yet supported (Phase 27) |

### Gaps Identified

1. **No automated health check monitoring**: Health checks exist but no alerting configured. Not re-verified in Phase 25.
2. **Runbooks reference Prisma**: Must update to Drizzle ORM queries (`RUNBOOKS.md` still does).
3. **No Redis persistence configured**: Still true, and there is no Redis provisioned at all (PHASE23-05). In addition, a worker dies on any Redis outage and does not recover by itself (Phase 25, see §4.3; PHASE19-03).
4. ~~**SECRET_ENCRYPTION_KEY not in .env.example**~~: **[CORRECTED]** It is in `.env.example`. It still has to be backed up offline.
5. ~~**No circuit breaker implementation**~~: **[CORRECTED]** The provider registry has a circuit breaker (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`, `CIRCUIT_BREAKER_COOLDOWN_MS`).
6. No admin recovery path for undecryptable secrets (PHASE15-04): §4.2 requires a direct SQL step.
7. `audit_logs` has no retention policy (PHASE20-05), and persisted error text is not redacted (PHASE22-02). Both are carried into every backup.

---

## 6. Recovery Contact Matrix

| Role | Responsibility | Escalation |
|------|---------------|------------|
| On-Call Engineer | First responder, triage, initial recovery | PagerDuty P1/P2 |
| Incident Commander | Coordinates recovery effort | Slack #incidents |
| Database SME | Neon operations, PITR, migration issues | On-call DBA |
| Infrastructure SME | Railway, Vercel, DNS, networking | Platform team lead |
| Security Lead | Security incidents, credential rotation | CISO |
| Provider SMEs | Provider-specific issues, dashboard access | Provider account managers |

### Emergency Contacts

| Service | Support Channel | Expected Response |
|---------|----------------|-------------------|
| Neon | support@neon.tech / Dashboard ticket | < 1 hour (paid tier) |
| Railway | Discord #support / Dashboard | < 4 hours |
| Vercel | Dashboard support | < 8 hours |
| Stripe | Dashboard support / Email | < 24 hours |
| Other providers | Email / Dashboard | < 24 hours |

---

## 7. Testing Cadence

| Test | Frequency | Procedure | Owner |
|------|-----------|-----------|-------|
| Gateway crash recovery | Monthly | Deploy, kill process, verify auto-restart | On-call |
| DB failover | Quarterly | Pause Neon, verify 503, restore, verify recovery | DB SME |
| Provider failover | Monthly | Set provider offline, verify routing failover | Provider SME |
| Webhook replay | Quarterly | Replay events from provider dashboard | Worker SME |
| PITR restore | Bi-annually | Full restore to staging, verify data integrity | DB SME |
| Full DR drill | Annually | Simulate complete infrastructure failure | Platform team |

The sandbox drills listed under "Verification status" (backup/restore, key loss, Redis data loss) are `*.postgres.integration.test.ts` suites, so CI's Postgres-backed integration job runs them on every PR. The backup/restore suite also needs `pg_dump`/`psql`/`gzip` on the runner and fails, rather than skips, without them. They have not yet been observed on a real CI run.

### Test Documentation Template

```markdown
## DR Test: [Scenario Name]

**Date:** YYYY-MM-DD
**Tester:** [Name]
**Environment:** [Staging/Production]

### Pre-test State
- [ ] Services running normally
- [ ] Database accessible
- [ ] Redis connected

### Test Execution
1. [Step 1]
2. [Step 2]
3. [Step 3]

### Results
- Actual RTO: [time]
- Data loss: [yes/no, amount]
- Issues encountered: [list]

### Post-test
- [ ] Services restored to normal
- [ ] No residual damage
- [ ] Documentation updated
```

---

## 8. Appendices

### Appendix A: Required Environment Variables

| Variable | Criticality | Backup Location |
|----------|-------------|-----------------|
| `DATABASE_URL` (gateway + worker) | CRITICAL | Password manager |
| `SECRET_ENCRYPTION_KEY` (gateway + worker) | CRITICAL | Password manager (OFFLINE backup) |
| `WEBHOOK_HMAC_SECRET` (gateway + worker, identical) | CRITICAL | Password manager |
| `PORTAL_JWT_SECRET` (gateway) | CRITICAL | Password manager |
| `REDIS_URL` (gateway + worker) | HIGH | Password manager |
| `ADMIN_API_CREDENTIALS` (named admin token hashes; each admin keeps their own plaintext token) | HIGH | Password manager |
| `STRIPE_SECRET_KEY` | HIGH | Stripe dashboard |
| `NMI_API_KEY` | HIGH | NMI dashboard |
| `FLUTTERWAVE_SECRET_KEY` | HIGH | Flutterwave dashboard |
| `PAWAPAY_API_KEY` | HIGH | PawaPay dashboard |
| `PAYCHANGU_API_KEY` | HIGH | PayChangu dashboard |
| `AIRWALLEX_CLIENT_ID` | HIGH | Airwallex dashboard |
| `AIRWALLEX_API_KEY` | HIGH | Airwallex dashboard |
| `SIGNALHOUSE_API_KEY` | MEDIUM | SignalHouse dashboard |
| `INFOBIP_API_KEY` | MEDIUM | Infobip portal |
| `FUTURESMS_API_KEY` | MEDIUM | FutureSMS dashboard |
| `GOOGLE_MAPS_API_KEY` | LOW | Google Cloud Console |
| `GEMINI_API_KEY` | LOW | Google AI Studio |

**[CORRECTED]** `PLATFORM_ADMIN_KEY` is no longer read by any code; it was removed with the old admin guard in Phase 20-21. Provider env-var credentials are only a fallback when no persisted secret exists (§4.2).

### Appendix B: Database Schema Reference

**[CORRECTED]** 37 tables across 23 migrations (`0000`–`0022`, `packages/database/drizzle/`), plus the drizzle journal `drizzle.__drizzle_migrations`:
- `applications`, `tenants`, `tenant_application_links`, `suppliers`
- `application_api_keys`, `application_permissions`
- `users`, `user_sessions`, `user_verification_tokens`, `roles`, `permissions`
- `providers`, `provider_configs`, `provider_capabilities`, `provider_health`
- `transactions`, `idempotency_records`, `checkout_sessions`, `plans`, `subscriptions`
- `events`, `outbox_events`, `audit_logs`
- `webhook_events`, `webhook_event_consumers`, `webhook_jobs`, `webhook_endpoints`
- `conversations`, `consent_records`, `messaging_profiles`, `sender_opt_outs`, `inbound_message_holds`, `keyword_commands`, `keyword_command_dispatches`
- `customer_notes`, `support_tickets`, `ticket_comments`

### Appendix C: Recovery Command Quick Reference

`<gateway-domain>` is a placeholder: no real domain is provisioned yet (PHASE23-04/05). The `api.company.com` used before is a template value.

```bash
# Liveness only (no dependency status)
curl -sf https://<gateway-domain>/health

# Readiness: per-dependency status (database, queue, rateLimiter, eventBus, providers, secrets)
curl -s https://<gateway-domain>/ready

# Railway status
railway status
railway logs --service api-gateway -n 50

# Neon connection test
psql "$DATABASE_URL_UNPOOLED" -c "SELECT 1, current_database(), version();"

# Redis connection test
redis-cli -u $REDIS_URL PING

# Database backup (see §3.1 — pg_dump >= the server's major version)
set -o pipefail; BACKUP="backup-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL_UNPOOLED" | gzip > "$BACKUP"

# Rollback: Railway dashboard → Deployments → ⋯ → Rollback (there is no `railway rollback`)
railway redeploy --service api-gateway

# Payments awaiting operator reconciliation (there is no "trigger reconciliation" endpoint;
# the old POST /api/dashboard/providers/reconciliation with X-Admin-Key returns 403, and the path does not exist)
curl -s https://<gateway-domain>/api/dashboard/payments/reconciliation \
  -H "x-admin-token: $YOUR_ADMIN_TOKEN"
```
