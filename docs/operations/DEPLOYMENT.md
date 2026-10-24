# Deployment Guide

## Prerequisites

Before deploying the platform, ensure you have:
- [ ] Accounts created: Railway, Vercel, Neon, GitHub
- [ ] Provider accounts: Stripe (test + live), Flutterwave, PawaPay, PayChangu, Airwallex, Infobip, SignalHouse
- [ ] Domain configured: `api.company.com`, `webhooks.company.com`, `console.company.com`
- [ ] All API keys and secrets collected (see Secret Inventory below)
- [ ] GitHub repository created and code pushed to `main`

---

## Environment Setup

### 1. Neon Database Setup

```bash
# 1. Create Neon account at neon.tech
# 2. Create project: "company-api-platform"
# 3. Create three branches: main (production), staging, dev
# 4. Copy connection strings for each branch

# 5. Run migrations on each branch (using Drizzle Kit)
DATABASE_URL="<neon-dev-connection-string>" npm run drizzle:migrate --workspace=@company/database
DATABASE_URL="<neon-staging-connection-string>" npm run drizzle:migrate --workspace=@company/database
DATABASE_URL="<neon-prod-connection-string>" npm run drizzle:migrate --workspace=@company/database

# 6. Validate schema matches code
DATABASE_URL="<neon-dev-connection-string>" npm run drizzle:check --workspace=@company/database
```

### 2. Railway Setup (API Gateway + Webhook Service)

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login

# Create project
railway new company-api-platform

# Deploy API Gateway
railway up --service api-gateway --dir services/api-gateway

# Deploy Webhook Service
railway up --service webhook-service --dir services/webhook-service

# Deploy Worker
railway up --service worker --dir services/worker
```

#### Railway Environment Variables (API Gateway)

Set in Railway Dashboard → Project → api-gateway → Variables:

```
NODE_ENV=production
PORT=3001
LOG_LEVEL=info

DATABASE_URL=<neon-prod-pooled-connection-string>
DATABASE_URL_UNPOOLED=<neon-prod-direct-connection-string>

ALLOWED_ORIGINS=https://console.company.com

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...   (set after step 3 below)

# NMI
NMI_API_KEY=...
NMI_API_URL=https://secure.nmi.com/api/transact.php

# Flutterwave
FLUTTERWAVE_SECRET_KEY=FLWSECK_LIVE-...
FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_LIVE-...
FLUTTERWAVE_SECRET_HASH=...

# PawaPay
PAWAPAY_API_KEY=...
PAWAPAY_API_URL=https://api.pawapay.io

# PayChangu
PAYCHANGU_SECRET_KEY=...
PAYCHANGU_WEBHOOK_SECRET=...

# Airwallex
AIRWALLEX_CLIENT_ID=...
AIRWALLEX_API_KEY=...

# Infobip
INFOBIP_API_KEY=...
INFOBIP_BASE_URL=https://<your-base-url>.api.infobip.com

# SignalHouse
SIGNALHOUSE_API_KEY=...
SIGNALHOUSE_WEBHOOK_SECRET=...

# Email
SMTP_HOST=smtp.company.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

### 2a. Railway Service Configuration (api-gateway, worker) — Phase 23-24

The values below are what the code in this repository expects. Railway's
dashboard settings are NOT in this repository (Railway "Config as Code"
`railway.json` is deprecated and cannot be adopted by new services), so each
item must be checked on the live service by someone with Railway access.

**Start strategy (decided in Phase 23-24).** Both services run their
TypeScript sources directly with an in-process transpile-only loader:

```
"start": "exec node --import tsx src/index.ts"
```

- Why not a compiled `dist/`: every workspace package (`@company/database`,
  `@company/providers`, ...) is consumed as TypeScript source (`"main":
  "src/index.ts"`). A plain `tsc` emit of a service produces
  `dist/services/<svc>/src/index.js` whose `require('@company/...')` still
  resolves to `.ts` files Node cannot load, so a real compiled artifact would
  mean either compiling and re-pointing every package or adding a bundler —
  an architecture change. The previous `"start": "node dist/index.js"` with
  `"build": "tsc --noEmit"` pointed at a file nothing ever produced and is the
  MODULE_NOT_FOUND crash the live deployment hit on every boot.
- `start` no longer depends on `build` having run, so the two can't drift
  apart again — and the live Railway build command (below) never runs
  `build` anyway.
- Type safety is not lost: transpile-only skips type checking at runtime, but
  CI's `Type check` gate and Railway's own build command (`type-check`) both
  type-check before anything starts. Startup cost measured locally: `/health`
  answers ~1–2 s after start.
- `tsx` is a runtime **dependency** of both services (not a devDependency),
  so a production install that prunes devDependencies still has it.
- `exec` matters: npm runs scripts via `sh -c`, and without `exec` a SIGTERM
  sent to `npm` (the process Railway's start command makes PID 1) killed npm
  and the shell but never reached the Node process — graceful shutdown never
  ran. With `exec`, npm forwards SIGTERM straight to the service.

**Settings to verify on each Railway service** (observed on the live
api-gateway service on 2026-10-23 where noted):

| Setting | api-gateway | worker |
|---|---|---|
| Build command | `npm install && npm run type-check -w services/api-gateway` (observed, correct as-is) | `npm install && npm run type-check -w services/worker` |
| Start command | `npm run start -w services/api-gateway` (observed, correct as-is) | `npm run start -w services/worker` |
| Healthcheck path | `/ready` (observed) | `/ready`, with `WORKER_HEALTH_PORT` equal to the port Railway probes (Railway probes `PORT`, so set both to the same value, e.g. `3002`) |
| Draining time (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) | ≥ 35 (Railway default is **0** = SIGKILL immediately; the gateway drains for up to 30 s) | ≥ 35 (the worker's shutdown waits up to 30 s) |
| Wait for CI (GitHub autodeploy) | **enabled** — Railway deploys straight from the GitHub repository, bypassing `.github/workflows/deploy.yml` (whose deploy steps are placeholders); only this setting makes a Railway deploy wait for the CI workflow, including the `Service boot smoke` gate | same |
| `TRUST_PROXY` | `1` — see below | n/a (no per-IP logic) |
| Required variables | `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `PORTAL_JWT_SECRET`, `WEBHOOK_HMAC_SECRET`, `SECRET_ENCRYPTION_KEY`, `ADMIN_API_CREDENTIALS`, `CORS_ORIGINS` | `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `WEBHOOK_HMAC_SECRET`, `SECRET_ENCRYPTION_KEY` |

Observed on 2026-10-23: the live api-gateway service had no `DATABASE_URL`,
`REDIS_URL`, `PORTAL_JWT_SECRET` or `ADMIN_API_CREDENTIALS` variables. With
those missing, the gateway now boots but `/ready` answers 503 (database,
provider state, admin credentials), so Railway's deploy-time healthcheck on
`/ready` will keep failing the deployment until they are set. In production
the worker refuses to start at all without a reachable database.

**`TRUST_PROXY` (PHASE14-03 / PHASE20-02).** Per-IP rate limits and the admin
lockout key on `req.ip`. Unset, `req.ip` is the TCP peer — behind Railway's
edge that is the edge's address for every caller, so all callers share one
bucket and 10 wrong admin-token guesses from anyone lock out every admin.
`TRUST_PROXY=1` trusts exactly one proxy hop: `req.ip` becomes the right-most
`X-Forwarded-For` entry (the one the edge appends), and anything a client
writes to the left of it is ignored. `true`/`*`/`0.0.0.0/0` are refused at boot
(error log `TRUST_PROXY_INVALID`, trust stays off), because blanket trust lets
any client pick its own `req.ip`. Accepted forms: a hop count `1`–`10`, or a
comma list of proxy IPs/CIDRs (`loopback`, `linklocal`, `uniquelocal` allowed).

Railway documents `X-Real-IP` as its client-IP header; it does not document
the exact `X-Forwarded-For` behaviour of its edge. Before relying on
`TRUST_PROXY=1`, verify it once on the live service: send
`curl -H 'X-Forwarded-For: 203.0.113.9' https://<gateway-domain>/health` and
confirm the gateway's `request received` log line shows your real address in
`ip`, not `203.0.113.9`. If it shows `203.0.113.9`, the edge is passing client
headers through unmodified — unset `TRUST_PROXY` again.

**Restarts (PHASE19-03).** Railway's healthcheck runs only at deploy time
(<https://docs.railway.com/deployments/healthchecks>); it never restarts a
running instance, and the restart policy acts only when the process exits. A
running instance whose queue fell back to memory at boot therefore reports
`/ready` 503 indefinitely and is NOT recovered by the platform. Until the
service itself acts on that (retrying Redis, or exiting so the restart policy
restarts it), recover it with a manual restart and alert on the readiness
signal. What Railway's `/ready` healthcheck does give: a NEW deployment that
comes up in that state never receives traffic.

**Logs (PHASE22-04).** Both services write one JSON object per line to
stdout, which Railway captures natively and parses as structured logs —
no log shipper is needed for day-to-day operation. Retention is Railway's
plan window (7 days Hobby, 30 days Pro, up to 90 days Enterprise); longer
retention (e.g. for audit or incident review) requires forwarding to an
external aggregator, which is a separate decision. `GET
/api/observability/logs` is only a 200-entry per-process ring buffer.

### 3. Webhook Registration (Per Provider)

After deploying the webhook service, register endpoints with each provider:

#### Stripe
```bash
# Install Stripe CLI
stripe listen --forward-to https://webhooks.company.com/webhooks/stripe

# OR via Stripe Dashboard:
# Settings → Webhooks → Add endpoint
# URL: https://webhooks.company.com/webhooks/stripe
# Events: payment_intent.succeeded, payment_intent.payment_failed, charge.refunded, charge.dispute.created

# Copy the webhook signing secret (whsec_...) → set STRIPE_WEBHOOK_SECRET in Railway
```

#### Flutterwave
```
Flutterwave Dashboard → Settings → Webhooks
URL: https://webhooks.company.com/webhooks/flutterwave
Secret Hash: <same value as FLUTTERWAVE_SECRET_HASH env var>
```

#### PawaPay
```
PawaPay Dashboard → Configuration → Webhook URLs
Deposit URL: https://webhooks.company.com/webhooks/pawapay
Payout URL: https://webhooks.company.com/webhooks/pawapay
```

#### PayChangu
```
PayChangu Dashboard → Settings → Webhooks
Webhook URL: https://webhooks.company.com/webhooks/paychangu
```

#### Infobip
```
Infobip Portal → Channels → SMS → Configuration
Delivery Report URL: https://webhooks.company.com/webhooks/infobip
```

#### SignalHouse
```
SignalHouse Dashboard → Webhooks → New Webhook
Endpoint: https://webhooks.company.com/webhooks/signalhouse
Events: message.delivered, message.failed
```

### 4. Vercel Setup (Admin Console)

```bash
# Install Vercel CLI
npm install -g vercel
vercel login

# Deploy admin console
cd apps/admin-console
vercel --prod

# Set environment variables
vercel env add VITE_GATEWAY_URL https://api.company.com
```

#### vercel.json
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/" }],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    }
  ]
}
```

### 5. Domain Configuration

```
# Railway custom domain
api.company.com         → Railway api-gateway service
webhooks.company.com    → Railway webhook-service service

# Vercel custom domain
console.company.com     → Vercel admin-console deployment

# DNS records (add at your DNS provider)
CNAME api.company.com        railway.app
CNAME webhooks.company.com   railway.app
CNAME console.company.com    cname.vercel-dns.com
```

---

## Deployment Pipeline (GitHub Actions)

### CI Pipeline (Every Pull Request)

Every PR must pass all of the following gates before merge:

| Gate | Command | Description |
|------|---------|-------------|
| Lint | `npm run lint` | ESLint with TypeScript rules |
| Type Check | `npm run type-check` | TypeScript compiler (strict mode) |
| Unit Tests | `npm test` | Vitest suite, with the `redis-server` binary installed so Redis-gated suites run; fails if any of them is skipped |
| Integration Tests | `npm run test:integration` | Vitest integration suites against a real PostgreSQL 16 service container (`TEST_POSTGRES_URL`); fails if any Postgres-gated test is skipped |
| Build | `npm run build:all` | Type-checks the services, builds the apps |
| Service Boot Smoke | `npx tsx scripts/service-boot-smoke.ts <svc>` | Starts each service with its real `npm run start -w services/<svc>` against a real Redis; requires `/health` 200, a `/ready` report failing only on the (unreachable in CI) database, and a clean exit on SIGTERM |
| Security Audit | `npm audit --audit-level=high` | Dependency vulnerability scan |
| Migration Check | `npm run drizzle:check` | Validate schema matches code |

All gates run in parallel for fast feedback. The `ci-gate` job requires all to pass.

### Production Deployment (Merge to `main`)

1. **Verify CI**: All CI gates must have passed on the PR
2. **Build**: Compile all workspaces
3. **Migration**: Validate then apply pending Drizzle migrations (requires `production` environment approval)
4. **Deploy**: Deploy API Gateway, Worker, and Admin Console
5. **Verify**: Health check and smoke tests

### Safety Controls

- **Never auto-destroy**: Database migrations use `drizzle-kit migrate` (forward-only)
- **No force push**: `drizzle-kit push` is forbidden in CI/CD
- **Human approval**: Production environment requires manual approval in GitHub
- **Rollback available**: Manual rollback via workflow dispatch

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `PRODUCTION_DATABASE_URL` | Neon PostgreSQL connection string |
| `RAILWAY_TOKEN` | Railway deployment token |
| `VERCEL_TOKEN` | Vercel deployment token |
| `TEST_DATABASE_URL` | Neon staging/test database URL |

### GitHub Environments

Configure the `production` environment in GitHub repository settings with:
- Required reviewers (at least 1)
- Wait timer: 5 minutes (optional)
- Deployment branches: `main` only

---

## Rollback Procedure

> **CRITICAL:** Never run `drizzle-kit push --force` or `DROP` commands on production.
> See `docs/operations/ROLLBACK.md` for detailed procedures.

### Code Rollback
```bash
# Railway: redeploy previous build
railway rollback --service api-gateway
railway rollback --service worker

# Vercel: revert to previous deployment
vercel rollback --token $VERCEL_TOKEN

# Or trigger via GitHub Actions
gh workflow run deploy.yml -f target=rollback
```

### Database Rollback
```bash
# NEVER run drizzle-kit push --force on production
# NEVER run DROP TABLE, DELETE FROM, or TRUNCATE on production

# Preferred: Create a forward migration that reverses the change
npm run drizzle:generate --workspace=@company/database

# Emergency: PITR restore via Neon Dashboard
# Neon → Project → Restore → Select timestamp
# See docs/operations/ROLLBACK.md for step-by-step
```

---

## Post-Deployment Verification

After every deployment, run the following verification checklist:

```bash
# 1. Health check
curl https://api.company.com/health
# Expected: {"status":"ok","uptime":...,"providers":{...}}

# 2. Readiness check
curl https://api.company.com/ready
# Expected: {"status":"ready"}

# 3. Test payment (Stripe sandbox)
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
```
