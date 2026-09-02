# ADR-003: Single API Gateway Entry Point

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

Client applications (ReachChurch, HaulPro, etc.) need to initiate payments, send messages, and call auxiliary APIs. We needed to decide the entry point architecture: should clients call each service directly, or route everything through a central gateway?

---

## Options Considered

### 1. Direct Service Calls
Each client app calls the relevant internal service directly:
- App → Payment service → Stripe
- App → Messaging service → Infobip
- App → Maps service → Google Maps

### 2. Backend-for-Frontend (BFF)
One dedicated gateway per client app, each with app-specific logic.

### 3. Single API Gateway (selected)
All requests from all apps flow through a single `services/api-gateway` service.

### 4. GraphQL Federation
Single GraphQL endpoint that federates subgraphs per domain.

---

## Decision

**Single API Gateway with centralized auth, rate limiting, and routing dispatch.**

---

## Rationale

### Cross-cutting concerns belong in one place
Authentication, rate limiting, request ID generation, structured logging, and input validation are required on every inbound request regardless of which provider is ultimately called. Implementing these in a single gateway means they're applied consistently and maintained in one place.

### Client apps should not know about provider topology
If we add a new payment provider (e.g., replacing Flutterwave with a different processor), no client app should need to change. The gateway absorbs provider changes invisibly.

### Against Direct Service Calls
- Auth logic duplicated across every service
- Client apps become tightly coupled to internal service topology
- Difficult to add cross-cutting concerns (rate limiting, audit logging) consistently
- Provider failover requires client-side retry logic

### Against BFF
- We have 8 client apps. 8 BFFs means 8x the operational overhead for nearly identical behavior (all apps do the same thing: initiate payments and send messages).
- BFF is appropriate when apps have significantly different data requirements (mobile vs desktop vs public API). Our apps don't — they all use the same `POST /api/gateway/payment` shape.

### Against GraphQL Federation
- Over-engineering: our API surface is simple (3 action types: payment, messaging, other). GraphQL's advantages (field selection, nested queries) don't apply here.
- Adds significant complexity with no functional benefit at current scale.

---

## Gateway Responsibilities (Single Responsibility Maintained)

The gateway is NOT a monolith. It:
1. **Authenticates** requests (reads `api_keys` table)
2. **Rate limits** requests (in-memory + Redis future)
3. **Validates** request bodies (Zod schemas)
4. **Tags** requests with a UUID request ID
5. **Dispatches** to `RoutingEngine` in `packages/routing`
6. **Normalizes** responses and errors

It does NOT:
- Contain routing logic (that's in `packages/routing`)
- Contain provider logic (that's in `providers/*`)
- Process webhooks (that's `services/webhook-service`)
- Reconcile transactions (that's `services/worker`)

---

## Consequences

**Positive**
- Single point for security enforcement — no way to bypass auth
- Unified request logging — every request is traceable
- Provider topology changes are invisible to client apps
- Simple client SDK: one base URL, one API key, 3 endpoint patterns

**Negative**
- Single gateway is a potential single point of failure (mitigated by Railway's auto-restart and load balancing on multiple instances)
- All traffic passes through one process — high-traffic events could create a bottleneck (mitigated by horizontal scaling; the gateway is stateless)
- Gateway must be updated whenever a new endpoint is added

**Future Consideration**
If traffic volume or team size grows significantly, splitting the gateway into domain-specific gateways (payment gateway, messaging gateway) becomes justified. The current monorepo structure makes this refactor straightforward — `services/payment-router` and `services/messaging-router` stubs are already defined.
