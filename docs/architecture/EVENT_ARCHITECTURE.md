# Event Architecture

## Overview

The platform uses two distinct event mechanisms:
1. **SSE (Server-Sent Events)** — real-time push of transaction events to the admin console
2. **Webhook Events** — inbound events from payment/messaging providers notifying the platform of async outcomes

This document covers the SSE event system. See [WEBHOOK_ARCHITECTURE.md](./WEBHOOK_ARCHITECTURE.md) for inbound webhooks.

---

## SSE Event Bus

### Purpose
The `packages/events` EventBus provides a publish-subscribe mechanism that:
- Accepts `TransactionEvent` objects emitted by the routing engine after each operation
- Forwards events to all active SSE client connections (admin console instances)
- Maintains a rolling in-memory history of the last 100 events (for new connections)

### Architecture

```
RoutingEngine.routePayment()
        │
        ▼ emits TransactionEvent
EventBus.emit()
        │
        ├──▶ SSE Client 1 (admin console tab 1)
        ├──▶ SSE Client 2 (admin console tab 2)
        └──▶ In-memory history buffer (last 100 events)
```

### SSE Connection Lifecycle

```
Client connects: GET /api/dashboard/stream
    │
    ▼
Server sends: data: {"type":"connected","timestamp":"..."}\n\n
    │
    ▼
Server holds connection open (no timeout)
    │
    ├── Every 30 seconds: Server sends keepalive ping
    │   data: {"type":"ping","timestamp":"..."}\n\n
    │
    ├── On new transaction: Server sends full TransactionEvent
    │   data: {"id":"...","status":"success","provider":"stripe",...}\n\n
    │
    └── Client disconnects → EventBus.unsubscribe() called → connection closed cleanly
```

### Client Reconnection Policy (admin console)

The admin console implements exponential backoff reconnection:

```typescript
let delay = 1000; // start at 1 second
const MAX_DELAY = 30_000; // cap at 30 seconds

eventSource.onerror = () => {
  eventSource.close();
  setTimeout(() => reconnect(), delay);
  delay = Math.min(delay * 2 + Math.random() * 1000, MAX_DELAY);
};

eventSource.onopen = () => {
  delay = 1000; // reset on successful connection
};
```

---

## TransactionEvent Schema

Every event published to the bus conforms to:

```typescript
interface TransactionEvent {
  id: string;              // Provider or platform transaction ID
  timestamp: string;       // ISO 8601
  appId: string;           // Client app slug
  category: 'payment' | 'messaging' | 'other';
  providerId: string;      // 'stripe' | 'infobip' | etc.
  status: 'success' | 'failed';
  
  // Payment-specific
  amount?: number;
  currency?: string;
  
  // Messaging-specific
  messageType?: 'sms' | 'email' | 'whatsapp';
  
  // Routing metadata
  latency: number;         // ms from routing decision to provider response
  cost: number;            // USD cost of this provider call
  decisionReason: string;  // Human-readable routing explanation
  attempts: number;        // 1 = first try, >1 = retried
  
  // Payloads
  payload: object;         // Sanitized request (no sensitive fields)
  response: object | null; // Provider response (sanitized)
  error?: string;          // Error message on failure
}
```

### Sensitive Field Sanitization

Before emitting to SSE, the following fields are stripped from `payload` and `response`:
- Credit card numbers, CVV, expiry
- Full phone numbers (replaced with masked version: `+254***0000`)
- Email addresses (replaced with: `us***@example.com`)
- Provider API keys or tokens

---

## Event Types by Category

### System Events (not `TransactionEvent` — sent as raw objects)

| Type | When Sent | Payload |
|------|-----------|---------|
| `connected` | On SSE connection established | `{ type, timestamp }` |
| `ping` | Every 30 seconds | `{ type, timestamp }` |
| `provider_config_changed` | Provider status/weight updated | `{ providerId, updates }` |
| `circuit_opened` | Circuit breaker trips for a provider | `{ providerId, timestamp }` |
| `circuit_closed` | Circuit breaker recovers | `{ providerId, timestamp }` |

### Transaction Events

Every completed routing operation emits a `TransactionEvent` with `status: success | failed`.

---

## EventBus Guarantees

| Guarantee | Status |
|-----------|--------|
| At-least-once delivery | ❌ No — SSE is fire-and-forget. If a client is disconnected during an event, it misses it. Historical events are available via `GET /api/dashboard/logs`. |
| Ordering | ✅ Yes — events are delivered in emission order within a single process |
| Durability | ❌ No — in-memory only. Process restart clears the buffer. `transactions` table is the durable record. |
| Backpressure | ❌ No — a slow SSE client receives events at the rate they are emitted. In practice, events are infrequent enough that this is not an issue. |

---

## Scalability Note

The current EventBus is in-process (single gateway instance). If the gateway scales to multiple instances, each instance has its own EventBus and SSE clients connected to it will only see events processed by that instance.

**Mitigation at current scale**: Single gateway instance is sufficient.  
**Future solution**: Replace in-process EventBus with Redis Pub/Sub. Each gateway instance subscribes to the Redis channel and forwards to its local SSE clients.
