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

# 5. Run migrations on each branch
DATABASE_URL="<neon-dev-connection-string>" npx prisma migrate deploy
DATABASE_URL="<neon-staging-connection-string>" npx prisma migrate deploy
DATABASE_URL="<neon-prod-connection-string>" npx prisma migrate deploy

# 6. Seed initial application records
DATABASE_URL="<neon-dev-connection-string>" npx ts-node packages/database/seed.ts
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

On merge to `main`:
1. CI runs: install → type-check → test
2. If CI passes: build Docker images, push to GHCR
3. Railway automatically pulls new image and redeploys
4. Vercel automatically redeploys admin console

See `infrastructure/github/workflows/` for full workflow definitions.

---

## Rollback Procedure

### Code Rollback
```bash
# Railway: redeploy previous build
railway rollback --service api-gateway

# Vercel: revert to previous deployment
vercel rollback --token $VERCEL_TOKEN
```

### Database Rollback
```bash
# NEVER run prisma migrate reset on production
# Instead, create a new migration that reverses the problematic change

# Emergency: PITR restore via Neon Dashboard
# Neon → Project → Restore → Select timestamp
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
