# Webhook Architecture

## Overview

Webhooks are asynchronous HTTP callbacks sent by external providers to notify the platform of events that occur after the initial API call completes. For example:
- A mobile money payment may take 30–120 seconds to complete after the initial API call returns `PENDING`
- A Stripe charge may be disputed hours after settlement
- An SMS delivery receipt arrives seconds after the message is dispatched

This document defines the complete inbound webhook processing pipeline.

---

## Why a Separate Webhook Service

Webhooks are handled by `services/webhook-service` (not `services/api-gateway`) because:

1. **Raw body requirement**: Webhook signature verification requires access to the exact raw request bytes. Express's `express.json()` middleware parses and re-serializes the body, potentially altering whitespace or key ordering and breaking HMAC signatures. The webhook service configures `express.raw()` for all webhook routes.

2. **Different security model**: Webhook endpoints are authenticated by provider signature (HMAC, JWT) — not by API keys. These are completely different auth mechanisms.

3. **Different scaling profile**: The gateway scales with client traffic. The webhook service scales with provider event volume. These can be different.

4. **Isolation**: A bug in webhook processing cannot crash the gateway serving client requests.

---

## Webhook Processing Pipeline

```
Provider (Stripe, Flutterwave, etc.)
    │
    │ POST /webhooks/:provider
    ▼
services/webhook-service
    │
    ├── 1. Raw body captured (before any parsing)
    │
    ├── 2. Provider identified from :provider path param
    │
    ├── 3. Signature Verification
    │       │
    │       ├── Verified ──▶ Continue
    │       └── Failed  ──▶ Return 401, log attempt, STOP
    │
    ├── 4. Parse payload to JSON
    │
    ├── 5. Extract provider_event_id
    │
    ├── 6. Idempotency check (SELECT from webhook_events WHERE provider_event_id = $1)
    │       │
    │       ├── Already exists ──▶ Return 200 immediately (idempotent), STOP
    │       └── New event ──▶ Continue
    │
    ├── 7. INSERT into webhook_events (status: 'pending', full raw_payload)
    │       │
    │       └── Return 200 to provider immediately (provider should not wait for processing)
    │
    └── 8. Process event (async, after 200 is sent)
            │
            ├── Match event_type to handler
            ├── Find associated transaction by provider_tx_id
            ├── Update transaction status in DB
            ├── Emit TransactionEvent to EventBus (→ SSE clients)
            └── Update webhook_events.status: 'processed' | 'failed'
```

**Critical**: Step 8 (processing) happens AFTER returning 200 to the provider. Providers expect a fast 200 response. If the provider times out waiting, it will retry the webhook — causing duplicates. The idempotency check in step 6 handles this.

---

## Signature Verification Per Provider

### Stripe
```typescript
// Raw body required — do not parse with JSON middleware first
const sig = req.headers['stripe-signature'] as string;
const event = stripe.webhooks.constructEvent(
  req.rawBody,         // Buffer, not string
  sig,
  process.env.STRIPE_WEBHOOK_SECRET
);
// Throws if invalid — caught and returns 401
```

### Flutterwave
```typescript
const hash = req.headers['verif-hash'];
if (hash !== process.env.FLUTTERWAVE_SECRET_HASH) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

### PawaPay
```typescript
// PawaPay uses JWT signed with their private key
// Verify using PawaPay's published public key
const decoded = jwt.verify(req.headers.authorization?.replace('Bearer ', ''), PAWAPAY_PUBLIC_KEY);
```

### PayChangu
```typescript
const expectedSig = crypto
  .createHmac('sha256', process.env.PAYCHANGU_WEBHOOK_SECRET)
  .update(req.rawBody)
  .digest('hex');
if (req.headers['x-paychangu-signature'] !== `sha256=${expectedSig}`) {
  return res.status(401).json({ error: 'Invalid signature' });
}
```

---

## Webhook Event Type Handlers

### Payment Events

| Provider | Event Type | Platform Action |
|----------|-----------|----------------|
| Stripe | `payment_intent.succeeded` | Set TX `status: success`, `settled_at: now()` |
| Stripe | `payment_intent.payment_failed` | Set TX `status: failed`, record `provider_error_code` |
| Stripe | `charge.refunded` | Insert new TX record with `category: refund` |
| Stripe | `charge.dispute.created` | Insert dispute record (future: alert operations) |
| Flutterwave | `charge.completed` | Set TX `status: success` |
| Flutterwave | `transfer.failed` | Set TX `status: failed` |
| PawaPay | `COMPLETED` | Set TX `status: success` |
| PawaPay | `FAILED` | Set TX `status: failed` |
| PayChangu | `payment.success` | Set TX `status: success` |
| Airwallex | `payment_intent.succeeded` | Set TX `status: success` |

### Messaging Events

| Provider | Event Type | Platform Action |
|----------|-----------|----------------|
| Infobip | `DELIVERED` | Update TX delivery status |
| Infobip | `UNDELIVERABLE` | Mark TX as failed delivery |
| SignalHouse | `message.delivered` | Update TX delivery status |
| SignalHouse | `message.failed` | Mark TX as failed |

---

## Idempotency Guarantee

A webhook may be delivered **more than once** by any provider (network retries, provider-side bugs). The platform guarantees each webhook event is processed **exactly once**:

```sql
INSERT INTO webhook_events (provider_id, provider_event_id, event_type, raw_payload, ...)
ON CONFLICT (provider_id, provider_event_id) DO NOTHING
RETURNING id
```

If `RETURNING id` returns null (conflict), the webhook was already processed. Return 200 immediately without processing.

---

## Failure Recovery

If step 8 (event processing) fails after the 200 is already returned:
- `webhook_events.status` remains `pending`
- `services/worker` scans for `webhook_events WHERE status = 'pending' AND received_at < NOW() - INTERVAL '5 minutes'`
- Worker re-processes failed webhooks up to 3 times with exponential backoff
- After 3 failures: `status: failed`, alert triggered (Slack/email to operations)

---

## Webhook Endpoint Registration

Each provider must be configured to send webhooks to:
```
https://webhooks.company.com/webhooks/:provider
```

| Provider | Webhook URL | Events to Subscribe |
|----------|-------------|---------------------|
| Stripe | `https://webhooks.company.com/webhooks/stripe` | `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created` |
| Flutterwave | `https://webhooks.company.com/webhooks/flutterwave` | All payment events |
| PawaPay | `https://webhooks.company.com/webhooks/pawapay` | All payment events |
| PayChangu | `https://webhooks.company.com/webhooks/paychangu` | `payment.success`, `payment.failed` |
| Infobip | `https://webhooks.company.com/webhooks/infobip` | Delivery reports |
| SignalHouse | `https://webhooks.company.com/webhooks/signalhouse` | Message status updates |

See [DEPLOYMENT.md](../operations/DEPLOYMENT.md) for step-by-step webhook registration instructions per provider.
