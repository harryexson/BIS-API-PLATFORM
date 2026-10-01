# ADR-005: Provider Adapter Pattern

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead

> **Amendment, 2026-09-15**: the "Adapter Structure" and "Adding a New
> Provider" sections below describe the design as originally proposed and
> no longer match the implementation exactly (paths, the `BaseProvider`
> contract, and several referenced files/packages that were never built —
> see the amendment notes inline). The decision and rationale below are
> still accurate and still the reason this pattern was chosen. For the
> actual, current, step-by-step process — kept in sync with the code, not
> re-litigated here — see **`docs/providers/ADDING_A_PROVIDER.md`**.

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

> **Amendment, 2026-09-15**: the actual path is
> `packages/providers/src/adapters/{payments,messaging,other}/*.ts`, not a
> top-level `providers/` directory — see
> `docs/providers/ADDING_A_PROVIDER.md` for the current, exact layout.

```
packages/providers/
  src/
    base.ts                      ← Abstract BaseProvider class
    registry.ts                  ← ProviderRegistry (loads all adapters)
    adapters/
      payments/
        stripe.ts                ← StripeProvider extends BaseProvider
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

> **Amendment, 2026-09-15**: `initialize()`/`checkHealth()`/
> `buildTransactionEvent()` below were never built this way. The real
> contract (`packages/providers/src/base.ts`) is simpler: config is set via
> the constructor, health is driven by `ProviderRegistry.runHealthCheck()`
> (see its own amendment note further down), and `processRequest()` builds
> its own `TransactionEvent` object literal rather than going through a
> shared builder. `isConfigured()` was added in this amendment pass — see
> `docs/providers/ADDING_A_PROVIDER.md`.

```typescript
abstract class BaseProvider {
  public config: ProviderConfig;

  constructor(config: ProviderConfig);

  // Credential injection — see ADDING_A_PROVIDER.md's "secrets" section.
  public setSecrets(secrets: Record<string, string>): void;
  protected get secrets(): Record<string, string>;

  // Core operation — each adapter implements this.
  abstract processRequest(
    appId: string,
    payload: PaymentRequest | MessageRequest | OtherRequest,
    decisionReason: string
  ): Promise<TransactionEvent>;

  // Shared utilities (implemented in BaseProvider, available to every adapter)
  protected http_request(opts: HttpRequestOptions): Promise<HttpResponse>;
  protected signPayload(payload: string): Promise<string>;
  protected verifyWebhookSignature(rawBody: string, signature: string, secret?: string): Promise<boolean>;
  protected toFormBody(params: Record<string, unknown>): string;
  protected simulateLatency(): Promise<number>;
  public measureLatency(): Promise<number>;
  protected verifyAvailability(): void;

  // Whether this adapter currently has real credentials — override this
  // if you build a real (non-simulated) HTTP integration.
  public isConfigured(): boolean;
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

> **Amendment, 2026-09-15**: the 8 steps originally listed here referenced
> `packages/config` (a Zod-schema package that was never built) and a
> `providers/payments/__tests__/` convention this repo doesn't use (tests
> are co-located, e.g. `payments/stripe.test.ts`), routing rules living in
> `packages/routing/src/index.ts` (payment/messaging provider routing is
> entirely inside `ProviderRegistry`'s capability matching — `packages/
> routing` is a different concern, conversation/keyword routing), and — the
> most consequential omission — said nothing about credentials/secrets at
> all, which would have shipped a provider whose admin-console-configured
> secret was silently ignored (the pre-2026-09-15 secrets pipeline was
> cosmetic; see `docs/providers/ADDING_A_PROVIDER.md`).
>
> The accurate, current, step-by-step process now lives in
> **`docs/providers/ADDING_A_PROVIDER.md`** — follow that, not this list.

---

## Consequences

**Positive**
- Adding or replacing a provider's routing/config behavior requires changes
  to exactly 2 files (adapter + registry) — see
  `docs/providers/ADDING_A_PROVIDER.md` for the full checklist beyond that
  (tests, `.env.example`, admin-console secret-field mapping)
- Routing engine depends on `BaseProvider` interface, not any concrete provider
- Each adapter is independently testable with mocked dependencies
- Provider-specific complexity is fully contained inside the adapter

**Negative**
- `ProviderRegistry` must be updated for each new provider (no auto-discovery)
- Static loading means all 13 adapters are initialized at startup even if not used
- `BaseProvider` abstract class creates a coupling between all adapters and the `packages/providers` package (intentional — this is the design)
