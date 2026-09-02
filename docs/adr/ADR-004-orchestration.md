# ADR-004: Orchestration Engine Design

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

When a client application makes a payment or messaging request, the platform must:
1. Decide which provider to use (routing)
2. Prepare the request (idempotency key, DB record)
3. Execute the provider call (with retry logic)
4. Handle the result (update DB, emit events)
5. Return a response to the client

The question is: where does this orchestration logic live, and how is it structured?

---

## Options Considered

### 1. Inline in Gateway Controllers
Each route handler in `services/api-gateway` directly contains routing, DB, and provider logic.

### 2. Dedicated Orchestration Microservice
A separate `services/orchestration-engine` HTTP service that the gateway calls for every request.

### 3. Shared Package (selected)
Orchestration logic lives in `packages/routing` (routing decisions) and `packages/providers` (provider execution), both consumed as in-process libraries by the gateway.

### 4. Saga Pattern with Event Sourcing
Each step of the orchestration is an event. A saga coordinator manages state transitions.

---

## Decision

**Shared package libraries consumed in-process by the gateway.**

The `services/orchestration-engine` stub is reserved for future extraction.

---

## Rationale

### Against Inline Controllers
Controllers should be thin. Putting routing logic, DB writes, retry logic, and event emission in a route handler creates an unmaintainable blob. Testing becomes impossible without spinning up the full Express server.

### Against Dedicated Microservice (at this stage)
- Adds network latency to every single request (the gateway calls orchestration, orchestration calls providers)
- Adds operational complexity: two services to deploy, monitor, and keep in sync
- The orchestration service has no independent scaling need — it scales exactly with the gateway
- The real benefit of a separate orchestration service (independent deployability, independent scaling, separate team ownership) doesn't apply at current team size

### For Shared Package Libraries
- **Zero network overhead**: routing decisions and provider calls happen in the same process as the gateway
- **Full type safety**: `RoutingEngine.routePayment()` returns `Promise<TransactionEvent>` — no JSON serialization/deserialization across a wire
- **Testable in isolation**: `packages/routing` unit tests don't need a running HTTP server
- **Easy extraction**: when the time comes to split into separate services, the interface (`RoutingEngine.routePayment()`) becomes an HTTP API with the same signature

### Against Saga/Event Sourcing
- Over-engineering for the current use case: each payment is a single provider call, not a multi-step distributed transaction
- Event sourcing adds significant complexity (event store, projections, replay) without benefit at this stage
- Revisit when multi-step workflows are required (e.g., split payments, escrow, installments)

---

## Orchestration Flow (Current Implementation)

```
services/api-gateway (HTTP handler)
  │
  ├── packages/database: check idempotency key
  ├── packages/database: insert transaction (status: pending)
  ├── packages/routing: RoutingEngine.routePayment()
  │     ├── packages/providers: ProviderRegistry.getProvider()
  │     ├── packages/resilience: CircuitBreaker.check()
  │     └── packages/providers: provider.processRequest()
  │           └── packages/http-client: axios call to Stripe (with retries)
  ├── packages/database: update transaction (status: success/failed)
  └── packages/events: EventBus.emit()
```

---

## Future Extraction Criteria

The `services/orchestration-engine` should be extracted from the gateway when ANY of the following are true:
1. The orchestration team is separate from the gateway team
2. Orchestration requires independent scaling (current: scales with gateway)
3. Multi-step workflows spanning multiple providers are required
4. Orchestration logic exceeds 3,000 lines of code in `packages/routing`

Until then, the stub folder exists to signal the architectural intent without premature extraction.

---

## Consequences

**Positive**
- Zero-latency routing decisions (in-process)
- Fully testable routing logic without HTTP
- Simple deployment (one less service to manage)

**Negative**
- Routing bugs can crash the gateway process (mitigated by error boundaries in the global error handler)
- Cannot independently scale routing logic from gateway
- Cannot use different language/runtime for routing (must be TypeScript/Node.js like the gateway)
