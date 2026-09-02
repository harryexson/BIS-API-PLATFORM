# Production Readiness Checklist

## Overview

This checklist gates the platform for production: pre-launch requirements, deployment steps, post-deployment verification, and recurring operational checks. Complete every section before going live and review the recurring sections on the stated cadence.

Companion documents:
- [Deployment Guide](./DEPLOYMENT.md)
- [Monitoring Guide](./MONITORING.md)
- [Incident Response](./INCIDENT_RESPONSE.md)
- [Runbooks](./RUNBOOKS.md)
- [Disaster Recovery](../architecture/DISASTER_RECOVERY.md)

---

## 1. Pre-Launch Checklist

### Accounts & Infrastructure
- [ ] Railway project created (`company-api-platform`) with api-gateway, webhook-service, worker services
- [ ] Vercel project connected for admin console
- [ ] Neon project created with `main` (production), `staging`, `dev` branches
- [ ] GitHub repo created, CI/CD workflow files in place
- [ ] Domains purchased and DNS pointed: `api.company.com`, `webhooks.company.com`, `console.company.com`

### Provider Accounts & Credentials
- [ ] Stripe (test + live), NMI, Flutterwave, PawaPay, PayChangu, Airwallex configured with live credentials
- [ ] Infobip, SignalHouse configured for messaging
- [ ] Email SMTP credentials configured
- [ ] All secrets stored in team password manager (never in git)
- [ ] All env vars set in Railway (see [DEPLOYMENT.md](./DEPLOYMENT.md) section 2)

### Webhooks
- [ ] Webhook endpoints registered with each provider (see [DEPLOYMENT.md](./DEPLOYMENT.md) section 3)
- [ ] Signing secrets verified for Stripe, PayChangu, SignalHouse, Flutterwave (secret hash)
- [ ] PawaPay deposit + payout URLs registered
- [ ] Infobip delivery report URL registered

### Database
- [ ] Migrations applied to all three Neon branches
- [ ] Seed data run (initial applications)
- [ ] Manual `pg_dump` backup taken (stored to cloud storage)
- [ ] Neon PITR confirmed enabled on paid tier

### Security
- [ ] `ALLOWED_ORIGINS` restricted to `https://console.company.com`
- [ ] Production error responses verified to omit stack traces
- [ ] Rate limits configured per application
- [ ] Admin console headers set (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`)
- [ ] API keys issued only via secure channels (dashboard / email to verified owners)

### Monitoring & On-Call
- [ ] Log drain configured (Railway → Logtail / Better Stack / Datadog)
- [ ] Alert rules deployed (P1–P4, see [MONITORING.md](./MONITORING.md))
- [ ] PagerDuty rotation populated, at least 2 engineers trained
- [ ] Slack `#platform-alerts` and `#incidents` channels created
- [ ] On-call engineers have read the runbooks and incident response docs
- [ ] Test alert fired and acknowledged successfully

---

## 2. Deployment Checklist (Every Release)

- [ ] Code reviewed and CI passed on the PR
- [ ] Type-check and tests passed (`npm run typecheck`, `npm test`)
- [ ] `main` merged → CI builds Docker images → GHCR tags pushed
- [ ] Railway picked up new images for api-gateway, webhook-service, worker
- [ ] Vercel redeployed admin console (if frontend changed)
- [ ] Database migrations applied (if schema changed) — with manual dump taken first
- [ ] New/changed env vars set BEFORE deploy
- [ ] Post-deployment verification run (section 3)
- [ ] Change announced in `#platform-alerts` (deploy window + what changed)

---

## 3. Post-Deployment Verification

```bash
# 1. Health check
curl https://api.company.com/health
# Expected: {"status":"ok","uptime":...,"providers":{...}}

# 2. Readiness check
curl https://api.company.com/ready
# Expected: {"status":"ready"}

# 3. Test payment (Stripe sandbox / live test key)
curl -X POST https://api.company.com/api/gateway/payment \
  -H "X-API-Key: bap_test_..." \
  -H "Content-Type: application/json" \
  -d '{"appId":"reachchurch","amount":10,"currency":"USD","paymentMethod":"card"}'
# Expected: {"status":"success","provider":"stripe",...}

# 4. Verify SSE stream
curl -N -H "Accept: text/event-stream" https://api.company.com/api/dashboard/stream
# Expected: data: {"type":"connected",...}

# 5. Admin console loads
curl https://console.company.com
# Expected: HTTP 200 with HTML content

# 6. Webhook path (send a test webhook from provider dashboard / CLI)
# Expected: webhook_events row created with status: processed
```

Also verify:
- [ ] No new errors in logs 10 minutes after deploy
- [ ] Circuit breaker states all CLOSED
- [ ] Transaction success rate back to normal

---

## 4. Daily Operations Checklist

- [ ] Skim `#platform-alerts` for overnight warnings
- [ ] Check dashboard: success rate, error rate, stale pending transactions
- [ ] Confirm no circuit breaker has been OPEN overnight
- [ ] Review webhook failure count (should be 0)
- [ ] Investigate any P3/P4 alerts from the previous day

---

## 5. Weekly Operations Checklist

- [ ] Review transaction volume and latency trends
- [ ] Check per-provider failure rates and latencies
- [ ] Verify database connection pool usage and query latency
- [ ] Confirm backup schedule running (Neon snapshots / manual dumps)
- [ ] Review rate limit usage per application (nearing limits? plan raises)
- [ ] Check provider bills for unexpected charges (fraud signal)

---

## 6. Monthly Operations Checklist

- [ ] Run gateway crash-recovery test in staging (see [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) testing table)
- [ ] Run provider failover test (set Stripe offline → verify NMI takes over)
- [ ] Review and rotate any credentials due for rotation
- [ ] Audit API keys: revoke unused/abandoned keys
- [ ] Review alerts for noise; tune thresholds if needed
- [ ] Verify on-call rotation calendar for the coming month
- [ ] Review open postmortem action items (must be zero)

---

## 7. Quarterly Operations Checklist

- [ ] DB failover test (pause Neon in staging, verify 503, restore, verify recovery)
- [ ] Webhook replay test (replay provider events to staging via CLI)
- [ ] PITR restore drill in staging
- [ ] Security review: dependencies, env vars, access to provider dashboards
- [ ] Disaster recovery walkthrough with the full team
- [ ] Re-certify on-call engineers on runbooks

---

## 8. Security Checklist (Ongoing)

- [ ] No secrets in git history (scan with secret scanner on every push)
- [ ] Provider credentials rotated after any suspected exposure
- [ ] Gateway CORS origin list reviewed quarterly
- [ ] `GET /health` does not leak internal details (no full env dumps)
- [ ] Webhook signature verification enabled for ALL providers (no gaps)
- [ ] Admin console accessible only via company auth (SSO/OAuth if available)
- [ ] Logs retained per retention policy (webhook payloads 90 days)

---

## 9. Data & Backup Checklist (Ongoing)

- [ ] Manual `pg_dump` before every migration (uploaded to cloud storage)
- [ ] Automated Neon backups verified (7-day retention)
- [ ] Backup restores tested at least bi-annually
- [ ] Critical data identified (transactions, webhook_events, api_keys, applications) — confirmed captured in backups

---

## 10. On-Call Readiness Checklist

- [ ] All on-call engineers have access to: Railway, Vercel, Neon, provider dashboards, password manager, PagerDuty, monitoring dashboard
- [ ] Each engineer has run at least one simulated incident in staging
- [ ] PagerDuty escalation paths tested end-to-end
- [ ] Runbooks accessible offline (PDF/print copy or mobile)
- [ ] Emergency contacts listed for each provider (support portals + tickets)

---

## Sign-Off

| Role | Name | Date | Signature / Link |
|------|------|------|------------------|
| Engineering lead | | | |
| On-call lead | | | |
| Security review | | | |

After sign-off, the platform is declared **production-ready**. Any subsequent change follows sections 2 and 3.
