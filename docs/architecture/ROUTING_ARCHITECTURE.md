# Routing Architecture

## Overview

The routing engine is the core decision-making component of the platform. It determines which provider handles each request based on a deterministic set of rules evaluated in priority order. This document defines the complete routing decision tree, fallback logic, weight-based selection, and circuit breaker integration.

---

## Routing Decision Priority Order

Every incoming request is evaluated through the following priority chain. The first matching rule wins.

```
Priority 1: Manual Override     → Client explicitly specified providerOverride
Priority 2: Currency Rules      → Hard-coded currency → provider mappings
Priority 3: Method Rules        → Payment method (card vs mobile_money) + currency
Priority 4: Weight-Based        → Weighted random selection among candidates
Priority 5: Fallback            → First available online provider in category
Priority 6: Error               → No provider available → 503
```

At each priority level, the circuit breaker state for the candidate provider is checked. If the circuit is `OPEN`, that provider is skipped and evaluation continues to the next priority level.

---

## Payment Routing Rules

### Rule Table

| Priority | Condition | Primary Provider | Fallback 1 | Fallback 2 |
|----------|-----------|----------------|------------|------------|
| 1 | `providerOverride` set | Override target | N/A | N/A |
| 2 | `currency = MWK` | PayChangu | Flutterwave | Weight-based |
| 3 | `currency ∈ {KES, UGX, GHS, TZS}` AND `method = mobile_money` | PawaPay | Flutterwave | Weight-based |
| 4 | `currency ∈ {NGN, GHS, ZAR, KES}` AND `method = card` | Flutterwave | Airwallex | Weight-based |
| 5 | `currency ∈ {USD, EUR, GBP, CAD, AUD}` | Stripe (70%) / NMI (30%) | Airwallex | First available |
| 6 | Any other currency | Airwallex | Stripe | First available |

### Decision Flow (Payment)

```
routePayment(appId, payload)
    │
    ├── [P1] providerOverride provided?
    │       ├── YES: provider.status === 'online' AND circuit CLOSED?
    │       │         ├── YES → use override → EXECUTE
    │       │         └── NO  → log warning → continue to P2
    │       └── NO: continue to P2
    │
    ├── [P2] currency === 'MWK'?
    │       ├── YES: PayChangu online + circuit CLOSED?
    │       │         ├── YES → EXECUTE PayChangu
    │       │         └── NO  → Flutterwave online + circuit CLOSED?
    │       │                     ├── YES → EXECUTE Flutterwave (fallback)
    │       │                     └── NO  → continue to P5
    │       └── NO: continue to P3
    │
    ├── [P3] currency ∈ Africa mobile money set + method = mobile_money?
    │       ├── YES: PawaPay online + circuit CLOSED?
    │       │         ├── YES → EXECUTE PawaPay
    │       │         └── NO  → Flutterwave mobile money online?
    │       │                     ├── YES → EXECUTE Flutterwave (fallback)
    │       │                     └── NO  → continue to P5
    │       └── NO: continue to P4
    │
    ├── [P4] currency ∈ Africa card set + method = card?
    │       ├── YES: Flutterwave online + circuit CLOSED?
    │       │         ├── YES → EXECUTE Flutterwave
    │       │         └── NO  → Airwallex online?
    │       │                     ├── YES → EXECUTE Airwallex (fallback)
    │       │                     └── NO  → continue to P5
    │       └── NO: continue to P5
    │
    ├── [P5] Weight-based selection from {Stripe, NMI, Airwallex}
    │         Filter: only online + circuit CLOSED
    │         If none available → continue to P6
    │
    └── [P6] Any payment provider online + circuit CLOSED?
              ├── YES → EXECUTE first available
              └── NO  → throw RoutingError('ALL_PROVIDERS_UNAVAILABLE') → 503
```

---

## Messaging Routing Rules

| Priority | Condition | Primary Provider | Fallback |
|----------|-----------|----------------|---------|
| 1 | `providerOverride` set | Override target | N/A |
| 2 | `recipient` contains `@` (email) | Email SMTP | SignalHouse |
| 3 | `content` contains `wa:` OR `content.length > 300` | SignalHouse | Infobip |
| 4 | `recipient` starts with `+254` or `+265` (Kenya/Malawi) | Future SMS | Infobip |
| 5 | All others (SMS default) | Infobip | Future SMS → SignalHouse |

---

## Other API Routing Rules

| Condition | Provider |
|-----------|---------|
| `serviceType = 'maps'` | Maps API |
| `serviceType = 'identity'` | Identity API |
| `serviceType = 'ai'` | Gemini AI API |
| Provider offline | First available in `other` category |

---

## Weight-Based Selection Algorithm

Used for step P5 (global cards: Stripe vs NMI vs Airwallex):

```typescript
function selectByWeight(candidates: ProviderConfig[]): ProviderConfig {
  const totalWeight = candidates.reduce((sum, p) => sum + p.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const candidate of candidates) {
    random -= candidate.weight;
    if (random <= 0) return candidate;
  }
  
  return candidates[candidates.length - 1]; // fallback: last in list
}
```

### Default Weights (configurable via dashboard)

| Provider | Weight | Effective % (alone) |
|----------|--------|---------------------|
| Stripe | 70 | 70% |
| NMI | 30 | 30% |
| Airwallex | 50 | backup only (only included if Stripe + NMI both offline) |

---

## Circuit Breaker Integration

Before executing any provider, the circuit breaker state is checked:

```
provider.status === 'online'     → proceed
provider.status === 'offline'    → skip immediately (manual override)
provider.status === 'maintenance' → skip immediately (manual override)
circuit.state === 'CLOSED'       → proceed normally
circuit.state === 'OPEN'         → skip, try next provider
circuit.state === 'HALF_OPEN'    → allow one probe request through
```

### Circuit Breaker Thresholds (defaults)

| Parameter | Value |
|-----------|-------|
| Failure threshold | 5 consecutive failures |
| Observation window | 60 seconds |
| Open duration | 120 seconds |
| Half-open probe interval | 30 seconds |
| Recovery: success count to close | 2 consecutive successes |

---

## Routing Audit Trail

Every routing decision is recorded in `transactions.routing_reason` as a human-readable string:

```
"Malawi Kwacha currency detected. Routed to PayChangu."
"Manual override matched: Forced routing to 'stripe'."
"Dynamic Failover: Stripe circuit is OPEN (5 failures in 60s). Re-routing to NMI."
"Routed via weight allocation (Stripe 70%/NMI 30%). Selected: Stripe (weight 70/100)."
```

This string is visible in the admin console's audit log and returned in every API response under `decisionReason`.

---

## Routing Configuration vs Code

| Routing parameter | Location | How to change |
|-------------------|----------|---------------|
| Provider status | DB `circuit_breaker_state` + admin dashboard | PATCH /api/dashboard/providers/:id |
| Provider weights | DB `provider_config` + admin dashboard | PATCH /api/dashboard/providers/:id |
| Currency → provider mapping | `packages/routing/src/index.ts` | Code change + PR |
| Circuit breaker thresholds | `packages/config` env vars | Env var change + redeploy |
| Rate limits | `packages/config` env vars + DB per-app | Env var or DB change |

**Principle**: Routing rules that change frequently (weights, status) are configurable via the dashboard without code changes. Routing rules that encode business policy (MWK → PayChangu) are in code and require a PR.
