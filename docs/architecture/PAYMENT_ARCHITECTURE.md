# Payment Architecture

## Overview

This document provides a comprehensive reference for all payment-related flows, provider capabilities, fee structures, currency coverage, and settlement timelines on the platform. It is intended as the operational source of truth for payment routing decisions.

---

## Provider Capability Matrix

| Provider | Card Payments | Mobile Money | Bank Transfer | Currencies | Regions |
|----------|:---:|:---:|:---:|-----------|---------|
| Stripe | ✅ | ❌ | ✅ (ACH) | 135+ | Global |
| NMI | ✅ | ❌ | ✅ (ACH) | USD, CAD | North America |
| Flutterwave | ✅ | ✅ | ✅ | NGN, GHS, KES, ZAR, USD + | Africa, Global |
| PawaPay | ❌ | ✅ | ❌ | KES, GHS, UGX, TZS, ZMW, MWK + | Africa (MNO) |
| PayChangu | ❌ | ✅ | ❌ | MWK | Malawi |
| Airwallex | ✅ | ❌ | ✅ | 100+ | Global |

---

## Fee Structure

| Provider | Card Fee | Mobile Money Fee | Flat Fee | Settlement |
|----------|----------|-----------------|----------|------------|
| Stripe | 2.9% | N/A | $0.30 | T+2 (USD) |
| NMI | 2.2% | N/A | $0.20 | T+2 |
| Flutterwave | 1.4% (local) / 3.8% (intl) | 1.0% | None | T+1–T+3 |
| PawaPay | N/A | 1.0% | None | T+0 (instant) |
| PayChangu | N/A | 1.5% | None | T+1 |
| Airwallex | 2.0% | N/A | None | T+1–T+2 |

---

## Payment Flow: Card Payment (Synchronous)

```
Client App
    │ POST /api/gateway/payment
    │ { amount: 100, currency: "USD", paymentMethod: "card" }
    ▼
API Gateway
    ├── Auth: validate X-API-Key
    ├── Validate: Zod schema
    ├── Idempotency: check/create key
    ├── DB: INSERT transaction (status: pending)
    └── RoutingEngine.routePayment()
              │
              ▼
        StripeProvider.processRequest()
              │ stripe.paymentIntents.create({
              │   amount: 10000,  // cents
              │   currency: 'usd',
              │   idempotencyKey: 'bap_idem_...'
              │ })
              │
              ▼
         [Stripe API]
              │
              ├── SUCCESS: { id: "pi_...", status: "succeeded" }
              │       │
              │       ▼
              │  DB: UPDATE transaction (status: success, provider_tx_id: "pi_...")
              │  EventBus.emit(TransactionEvent)
              │  Return 200 to client
              │
              └── FAILURE: { error: { code: "card_declined", ... } }
                      │
                      ▼
                 DB: UPDATE transaction (status: failed)
                 RoutingEngine: try next provider (if retryable)
                 Return 402/503 to client
```

---

## Payment Flow: Mobile Money (Asynchronous)

Mobile money payments are inherently asynchronous. The provider confirms acceptance immediately but settlement takes 30 seconds to 5 minutes.

```
Client App
    │ POST /api/gateway/payment
    │ { amount: 500, currency: "KES", paymentMethod: "mobile_money", phoneNumber: "254700000000" }
    ▼
API Gateway
    └── RoutingEngine → PawaPayProvider.processRequest()
              │
              ▼
         [PawaPay API]
         pawapay.deposits.create({
           depositId: "paw-uuid",
           amount: "500",
           currency: "KES",
           payer: { type: "MSISDN", address: { value: "254700000000" } }
         })
              │
              ▼
         { depositId: "paw-uuid", status: "ACCEPTED" }   ← immediate (not settled yet)
              │
              ▼
         DB: UPDATE transaction (status: pending, provider_tx_id: "paw-uuid")
         Return 202 Accepted to client:
         { "status": "pending", "id": "paw-uuid", "settlesViaWebhook": true }

[30 seconds to 5 minutes later]

PawaPay → POST /webhooks/pawapay
    { depositId: "paw-uuid", status: "COMPLETED" }
              │
              ▼
         Webhook Service: signature verify → deduplicate → process
         DB: UPDATE transaction (status: success, settled_at: now())
         EventBus.emit(TransactionEvent { status: "success" })
         SSE → Admin Console updates
```

---

## Idempotency Implementation

### Key Generation

```typescript
function generateIdempotencyKey(appId: string, payload: PaymentPayload): string {
  const bucket = Math.floor(Date.now() / 300_000); // 5-minute windows
  const raw = `${appId}:${payload.amount}:${payload.currency}:${payload.paymentMethod}:${bucket}`;
  return 'bap_idem_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
```

### Deduplication Check

```sql
INSERT INTO idempotency_keys (key, application_id, request_hash, expires_at)
VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
ON CONFLICT (key, application_id) DO NOTHING
RETURNING id, transaction_id, response_body;
```

If the `INSERT` returns nothing (conflict): a transaction already exists for this key.
- If the existing transaction is `success` or `failed`: return cached response body
- If the existing transaction is `pending`: return 202 with transaction ID for status polling

---

## Reconciliation (Worker Service)

The worker runs every 5 minutes and looks for transactions in `pending` state older than 5 minutes:

```sql
SELECT * FROM transactions
WHERE status = 'pending'
  AND created_at < NOW() - INTERVAL '5 minutes'
  AND provider_tx_id IS NOT NULL
ORDER BY created_at ASC
LIMIT 50;
```

For each found transaction, the worker calls the provider's transaction query API:
- Stripe: `stripe.paymentIntents.retrieve(provider_tx_id)`
- PawaPay: `pawapay.deposits.get(provider_tx_id)`
- Flutterwave: `flutterwave.Transaction.verify({ id: provider_tx_id })`

Based on the provider's response, the worker updates the transaction status to `success` or `failed`.

---

## Currency Routing Reference

| Currency | Code | Routed To | Method | Notes |
|----------|------|-----------|--------|-------|
| US Dollar | USD | Stripe (70%) / NMI (30%) | Card | Weight-based |
| Euro | EUR | Stripe | Card | — |
| British Pound | GBP | Stripe | Card | — |
| Nigerian Naira | NGN | Flutterwave | Card / Mobile | Primary Africa processor |
| Kenyan Shilling | KES | PawaPay (mobile) / Flutterwave (card) | Mobile Money / Card | Method-dependent |
| Malawian Kwacha | MWK | PayChangu | Mobile Money | Malawi-specific |
| Ghanaian Cedi | GHS | PawaPay (mobile) / Flutterwave (card) | Mobile Money / Card | Method-dependent |
| Ugandan Shilling | UGX | PawaPay | Mobile Money | — |
| Tanzanian Shilling | TZS | PawaPay | Mobile Money | — |
| South African Rand | ZAR | Flutterwave | Card | — |
| Other | * | Airwallex | Card | Global fallback |

---

## Payout / Refund Policy

- Refunds are initiated via `POST /api/gateway/payment` with `paymentMethod: "refund"` and `parentTransactionId`
- The platform calls the provider's refund API using the stored `provider_tx_id`
- Refund timing follows provider policy: Stripe T+5–10 days, Flutterwave T+7–14 days
- Partial refunds supported where provider supports them (Stripe: yes, PawaPay: no)
