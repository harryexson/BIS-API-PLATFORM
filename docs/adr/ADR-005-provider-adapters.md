# ADR-005: Provider Adapter Pattern

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

---

## Context

The platform must integrate with 13 external providers across three categories (payment, messaging, other). Each provider has a unique:
- API authentication mechanism
- Request/response format
- Error code vocabulary
- Rate limit constraints
- Retry semantics
- Webhook event types

We need a design pattern that allows each provider to be integrated, tested, and replaced independently without affecting the routing engine or the gateway.

---

## Options Considered

### 1. Direct Integration in Routing Engine
Route handler calls provider-specific code directly. All Stripe logic embedded in `RoutingEngine.routePayment()`.

### 2. Strategy Pattern with Interface
Define a `PaymentProvider` interface. Each provider class implements it. Routing engine depends only on the interface.

### 3. Adapter Pattern (selected)
Each provider has a dedicated adapter class that translates between the platform's internal format and the provider's API. Adapters implement a common `BaseProvider` abstract class.

### 4. Plugin Registry with Dynamic Loading
Providers registered as plugins and dynamically loaded at runtime from a registry configuration.

---

## Decision

**Adapter Pattern with `BaseProvider` abstract class and `ProviderRegistry` singleton.**

---

## Adapter Structure

```
packages/providers/
  src/
    base.ts           ← Abstract BaseProvider class
    index.ts          ← ProviderRegistry (loads all adapters)

providers/            ← Concrete adapter implementations
  payments/
    stripe.ts         ← StripeProvider extends BaseProvider
    nmi.ts
    flutterwave.ts
    pawapay.ts
    paychangu.ts
    airwallex.ts
  messaging/
    signalhouse.ts
    infobip.ts
    futuresms.ts
    email.ts
  other/
    maps.ts
    identity.ts
    ai.ts
```

### `BaseProvider` Contract

```typescript
abstract class BaseProvider {
  abstract config: ProviderConfig;
  
  // Lifecycle
  abstract initialize(config: ProviderConfig, httpClient: HttpClient): void;
  abstract checkHealth(): Promise<ProviderHealthResult>;
  
  // Core operation
  abstract processRequest(
    appId: string,
    payload: unknown,
    decisionReason: string
  ): Promise<TransactionEvent>;
  
  // Shared utilities (implemented in BaseProvider)
  protected verifyAvailability(): void;
  protected buildTransactionEvent(partial: Partial<TransactionEvent>): TransactionEvent;
}
```

### Adapter Responsibilities (each concrete adapter)

1. Translate platform request → provider-specific API call
2. Handle provider authentication (inject API key, OAuth token)
3. Map provider error codes → `ProviderError` (platform standard)
4. Return standardized `TransactionEvent`
5. Implement `checkHealth()` using a lightweight provider API call
6. NOT implement retry logic (handled by `packages/http-client`)
7. NOT implement circuit breaking (handled by `packages/resilience`)
8. NOT write to database (handled by the gateway controller)

This is a strict separation of concerns. An adapter does one thing: translate between platform format and provider format.

---

## ProviderRegistry

A singleton that:
- Instantiates and holds references to all provider adapter instances
- Injects shared dependencies (HttpClient, Logger, Config) into each adapter
- Exposes `getProvider(id)` and `getAllConfigs()` to the routing engine
- Supports runtime `updateProviderConfig(id, updates)` for status/weight changes from the dashboard

---

## Rationale

### Against Direct Integration
- Routing engine becomes a 2,000-line class that must be changed every time a provider changes their API
- Impossible to test Stripe logic without testing all routing logic simultaneously

### Against Strategy Pattern (interface only, no base class)
- Would require each adapter to re-implement shared utilities (availability check, event building)
- No enforcement of the contract — a provider could skip implementing `checkHealth()`
- Abstract class provides the right balance: mandatory interface via `abstract` methods + shared utilities via `protected` methods

### Against Plugin Registry
- Dynamic loading loses TypeScript type safety (adapters loaded at runtime can't be checked at compile time)
- Adds complexity (plugin manifest, version compatibility) without benefit at current scale
- 13 providers is small enough to load statically

---

## Adding a New Provider

To add a new provider (e.g., `MoMoPay`):

1. Create `providers/payments/momopay.ts` extending `BaseProvider`
2. Implement all abstract methods
3. Add to `ProviderRegistry.initializeProviders()` in `packages/providers/src/index.ts`
4. Add routing rules to `packages/routing/src/index.ts`
5. Add env vars to `packages/config` Zod schema
6. Add to `ROUTING_ARCHITECTURE.md` routing table
7. Write tests in `providers/payments/__tests__/momopay.test.ts`
8. Write docs in `docs/providers/momopay.md`

No other files need to change.

---

## Consequences

**Positive**
- Adding or replacing a provider requires changes to exactly 2 files (adapter + registry)
- Routing engine depends on `BaseProvider` interface, not any concrete provider
- Each adapter is independently testable with mocked dependencies
- Provider-specific complexity is fully contained inside the adapter

**Negative**
- `ProviderRegistry` must be updated for each new provider (no auto-discovery)
- Static loading means all 13 adapters are initialized at startup even if not used
- `BaseProvider` abstract class creates a coupling between all adapters and the `packages/providers` package (intentional — this is the design)
