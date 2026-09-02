# Security Architecture

## Overview

Security is applied in layers across the platform. No single control is relied upon exclusively. This document defines the threat model, security controls at each layer, and the policies governing secrets, authentication, and data protection.

---

## Threat Model

| Threat | Description | Controls |
|--------|-------------|----------|
| Unauthorized API access | Unauthenticated client calls gateway | API key auth + HTTPS |
| API key leakage | Key exposed in logs or code | Prefix-only logging, hash storage, scoped keys |
| Replay attacks | Attacker reuses captured valid request | Idempotency keys + request timestamps |
| Webhook spoofing | Attacker sends fake webhook to webhook-service | HMAC signature verification per provider |
| SQL injection | Malicious input in query parameters | Prisma parameterized queries only |
| Rate limit abuse | Client floods gateway to exhaust resources | Per-key rate limiting |
| Provider credential exposure | API keys leaked | Env vars only, never in DB, never logged |
| SSRF | Server-side request forgery via routing | Allowlist of permitted outbound domains |
| Excessive data exposure | API returns more data than client needs | Response schemas strictly typed |
| Insecure headers | Browser-based console vulnerable to XSS/clickjacking | Helmet.js middleware |

---

## Layer 1: Network / Transport

- **TLS 1.2+ enforced** on all inbound connections (handled by Railway + Vercel infrastructure)
- **HTTPS Strict Transport Security (HSTS)** header set by Helmet: `max-age=31536000; includeSubDomains`
- **No HTTP fallback** — all endpoints require HTTPS
- **Outbound to providers**: only HTTPS, certificate validation enforced (no `rejectUnauthorized: false`)

### Allowed Outbound Domains (Allowlist)
```
api.stripe.com
api.nmi.com
api.flutterwave.com
api.pawapay.io
api.paychangu.com
api.airwallex.com
rest.signalhouse.io
api.infobip.com
api.futuresms.net
smtp.company.com
maps.googleapis.com
identity.company.com
generativelanguage.googleapis.com
```
No outbound calls to unlisted domains are made by platform code.

---

## Layer 2: API Authentication

### API Key Design
- Format: `bap_live_<32 random chars>` (live) or `bap_test_<32 random chars>` (test)
- First 8 chars stored as `prefix` in `api_keys` table for display
- Full key is SHA-256 hashed before storage — the raw key is never persisted
- Keys are scoped per application (`application_id` FK)
- Keys can be revoked (`revoked_at` timestamp)
- Keys expire optionally (`expires_at`)

### Request Authentication Flow
```
1. Client sends: X-API-Key: bap_live_abc123...
2. Gateway extracts key from header
3. Gateway computes SHA-256(key)
4. Query: SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
5. If found: application_id attached to request context
6. If not found: 401 Unauthorized returned immediately
```

### What is Never Logged
- Raw API key values
- Provider secret API keys
- Webhook signing secrets
- Card numbers or payment credentials (never received)

---

## Layer 3: Rate Limiting

- **Scope**: Per API key (not per IP — multi-tenant IPs share gateways)
- **Default limit**: 100 requests per minute per key (configurable per application)
- **Algorithm**: Sliding window counter
- **Storage**: In-process `express-rate-limit` (upgrade to Redis for multi-instance)
- **Response on limit**: `429 Too Many Requests` with `Retry-After` header
- **Burst allowance**: 20 requests in 1 second permitted before rate limit activates

---

## Layer 4: Input Validation

All inbound request bodies are validated with Zod schemas before any business logic executes:

```typescript
// Example: Payment request schema
const PaymentRequestSchema = z.object({
  appId: z.string().min(1).max(64),
  amount: z.number().positive().max(1_000_000),
  currency: z.enum(['USD', 'EUR', 'NGN', 'KES', 'MWK', ...]),
  paymentMethod: z.enum(['card', 'mobile_money']),
  phoneNumber: z.string().optional(),
  idempotencyKey: z.string().max(255).optional(),
  providerOverride: z.string().optional()
});
```

Validation failures return `400 Bad Request` with a structured error listing all invalid fields. No raw Zod output is sent — it is sanitized to remove internal schema details.

---

## Layer 5: Webhook Security

Each provider uses a different webhook signature scheme:

| Provider | Scheme | Header | Verification |
|----------|--------|--------|--------------|
| Stripe | HMAC-SHA256 | `Stripe-Signature` | `stripe.webhooks.constructEvent(rawBody, sig, secret)` |
| Flutterwave | SHA-256 hash | `verif-hash` | `hash === FLUTTERWAVE_SECRET_HASH` |
| PawaPay | Neon JWT | `Authorization` | JWT verify with PawaPay public key |
| PayChangu | Hmac-SHA256 | `X-Paychangu-Signature` | Custom HMAC comparison |
| Infobip | Bearer token | `Authorization` | Static token comparison |
| SignalHouse | HMAC-SHA256 | `X-SignalHouse-Signature` | Custom HMAC comparison |

**Critical**: Webhook endpoints use a raw body parser. Express's `express.json()` must NOT process webhook routes — parsing the body before HMAC verification invalidates the signature.

---

## Layer 6: HTTP Security Headers (Helmet.js)

```
Content-Security-Policy:    default-src 'self'; connect-src 'self' api.company.com
Strict-Transport-Security:  max-age=31536000; includeSubDomains; preload
X-Frame-Options:            DENY
X-Content-Type-Options:     nosniff
Referrer-Policy:            strict-origin-when-cross-origin
Permissions-Policy:         camera=(), microphone=(), geolocation=()
```

---

## Layer 7: Secrets Management

### Environment Variables (all services)
- Loaded from `.env` locally, from Railway / Vercel environment settings in production
- Never committed to version control (`.env` is in `.gitignore`)
- `.env.example` committed with placeholder values and descriptions

### Secret Rotation Policy
- **Provider API keys**: Rotatable without service restart (config hot-reload on `SIGHUP`, future)
- **Webhook secrets**: Rotatable by updating env var + redeployment
- **Database credentials**: Managed by Neon, rotatable via dashboard
- **API keys (platform)**: Revocable via admin action (sets `revoked_at` in DB)

---

## Layer 8: Error Handling (Information Disclosure)

In `NODE_ENV=production`:
- Stack traces are NEVER returned in HTTP responses
- Provider error objects are NEVER returned raw — mapped to platform error format
- Database errors are logged server-side only, never exposed to client
- The only information returned on error is: HTTP status code, platform error code, human-readable message

```json
// Production error response (example)
{
  "error": {
    "code": "PAYMENT_PROVIDER_UNAVAILABLE",
    "message": "Payment processing is temporarily unavailable. Please try again.",
    "request_id": "req_abc123"
  }
}
```

---

## CORS Policy

```typescript
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [];

cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Request-ID'],
  credentials: false
})
```
