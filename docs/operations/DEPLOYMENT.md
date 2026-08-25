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
| Unit Tests | `npm test` | Vitest unit test suite |
| Integration Tests | `npm run test:integration` | Vitest integration tests |
| Build | `npm run build:all` | Build all workspaces |
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
