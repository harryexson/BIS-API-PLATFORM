# ADR-008: Payment Flow Design

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead, Finance Team

---

## Context

Payment operations are the highest-stakes actions the platform performs. Errors here have direct financial consequences:
- **Double-charges**: Customer charged twice for one purchase
- **Lost payments**: Payment succeeded at provider but not recorded in platform
- **Inconsistent state**: Platform says pending, provider says failed
- **Unauthorized charges**: API misuse results in charges to wrong account

We needed to design a payment flow that is safe, auditable, and recoverable under failure conditions.

---

## Requirements

1. **No double-charges**: Retrying a payment request must never result in two charges
2. **No lost payments**: If the platform crashes after charging the provider but before updating the DB, the charge must be detectable and the record must be recoverable
3. **Auditability**: Every payment must have an immutable record from initiation to settlement
4. **Consistency**: Platform's view of a transaction's status must eventually converge with the provider's view
5. **Failure isolation**: A payment failure for one app must not affect payments for other apps

---

## Key Design Decisions

### Decision 1: Write to DB Before Calling Provider

**Pattern**: Record-before-act

```
1. Generate idempotency key
2. INSERT transactions (status: pending) — if conflict on idempotency key, return cached response
3. Call provider API
4. UPDATE transactions (status: success/failed)
5. Return response to client
```

**Why**: If we crash after step 3 but before step 4, the `pending` transaction record exists. The worker can query the provider using the `provider_tx_id` reference (stored in the pending record) to determine the actual outcome and update the record.

**Alternative rejected**: Call provider first, then write to DB.
- If server crashes after provider call but before DB write: money moved but no record exists. Undetectable.

### Decision 2: Idempotency Keys Are Platform-Generated (with client-override option)

The platform generates idempotency keys by default:
```typescript
const idempotencyKey = clientKey ?? generateKey(appId, amount, currency, requestTimeBucket);
```

Time bucket = floor(Date.now() / 300_000) — 5-minute windows.

This means: the same app sending the same amount in the same currency within 5 minutes gets the same idempotency key → second request returns the cached response without a new provider call.

Clients can override with their own key for longer-lived idempotency.

**Why 5-minute bucket (not unique-per-request)**: A client that retries due to a network timeout (they didn't receive the response) should NOT generate a new charge. The 5-minute bucket catches this case automatically without requiring clients to manage idempotency keys.

### Decision 3: Transaction Status Is Eventually Consistent

The platform returns `status: success` to the client when the **provider's synchronous API response** indicates success. However, for mobile money payments (PawaPay, PayChangu), the provider's synchronous response is `PENDING` — the actual settlement confirmation comes via webhook minutes later.

```
Mobile Money Flow:
1. POST /api/gateway/payment → PawaPay API → {"depositId": "...", "status": "PENDING"}
2. Platform returns: {"status": "pending", "id": "paw-..."}  ← client sees this immediately
3. [30-120 seconds later] PawaPay sends webhook: {"status": "COMPLETED"}
4. Webhook service updates transaction: status: success
5. SSE event emitted: {"id": "paw-...", "status": "success"}  ← admin console updates
```

Client apps must handle `status: pending` for mobile money. They should subscribe to webhooks or poll `GET /api/gateway/transaction/:id` for status updates.

### Decision 4: Settlement via Webhooks, Not Polling

The platform does NOT poll providers for transaction status. It relies on inbound webhooks for settlement confirmation. The worker reconciles only transactions that have been `pending` for more than 5 minutes without a webhook (which indicates the webhook may have been missed).

**Why**: Polling N providers for all transactions in-flight creates O(providers × active_transactions) API calls. Webhooks are event-driven and scale linearly with actual settlement events.

### Decision 5: Refunds Are Separate Transactions

A refund is not an update to the original transaction record. It is a new `transactions` row with:
```
category: 'payment'
payment_method: 'refund'
amount: <negative value or refund amount>
parent_transaction_id: <original transaction id>
```

**Why**: Mutating the original transaction loses the audit trail of what was originally charged. The original transaction remains immutable. The refund record shows the reversal.

---

## Payment State Machine

```
                    ┌─────────┐
                    │ PENDING │ ←─── Created before provider call
                    └────┬────┘
                         │
           ┌─────────────┼─────────────┐
           │             │             │
           ▼             ▼             ▼
      ┌─────────┐  ┌──────────┐  ┌─────────────┐
      │ SUCCESS │  │  FAILED  │  │ RECONCILING │
      └─────────┘  └──────────┘  └──────┬──────┘
                                         │
                              Worker queries provider
                                         │
                              ┌──────────┼──────────┐
                              ▼          ▼           ▼
                           SUCCESS    FAILED    UNKNOWN → FAILED (after 7 days)
```

---

## Consequences

**Positive**
- Double-charge impossible: idempotency key prevents second provider call
- Lost payment detectable: pending record + worker reconciliation
- Immutable audit trail: every state transition recorded
- Mobile money safe: pending state natively supported

**Negative**
- DB write required before every provider call adds ~5ms latency
- Idempotency table requires periodic cleanup (handled by worker)
- Clients must handle asynchronous settlement for mobile money
- 5-minute idempotency window means genuine duplicate requests within that window are deduplicated — this is the intended behavior, but clients must be aware
