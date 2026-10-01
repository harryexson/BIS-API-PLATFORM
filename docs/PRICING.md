# Pricing Structure (Proposal)

**Status: proposed starting point, not finalized.** The per-transaction percentages below are
industry-benchmarked (comparable to how Adyen for Platforms, Lemonway, and Stripe Connect price
platform fees on top of pass-through interchange), not yet validated against BIS's own
infrastructure cost basis (Neon compute, hosting, support staffing). Treat every number here as a
draft to pressure-test, not a locked commitment. Open decisions are called out at the end.

## The model

Usage-based, no seat licenses, no subscription minimum on the entry tiers. Every transaction has
two cost components, always itemized separately so a customer can see exactly what they're paying
for:

1. **Provider fee** — the underlying rail's own processing cost (Stripe's card fee, Flutterwave's
   mobile money fee, and so on). This is a pure pass-through. BIS does not mark it up.
2. **Platform fee** — what BIS charges for routing, automatic failover, idempotency, webhook
   verification, and durability. This is the part that gets cheaper per transaction as volume grows
   across tiers.

Two rules apply platform-wide:

- **The platform fee is charged only on successful, settled transactions.** A failed or declined
  attempt costs the customer nothing, even though BIS still did the routing work.
- **The platform fee is not refunded when the underlying charge is refunded** (the provider's own
  fee refund policy is whatever that provider does). This matches standard processor practice — flag
  it if the business wants different behavior.

## Tiers

| Tier | Who it's for | Volume band | Payment platform fee | Messaging platform fee | Support |
|---|---|---|---|---|---|
| **Free** | Testing, evaluation | Sandbox only, unlimited test-mode calls | $0 | $0 | Community / docs |
| **Growth** | Early-stage apps, first real volume | Up to 1,000 live transactions/mo | 0.5% + $0.05 | $0.01/message | Email |
| **Scale** | Growing volume | 1,001–25,000 live transactions/mo | 0.3% + $0.03 | $0.006/message | Priority (email + chat) |
| **Enterprise** | High volume, dedicated corridors | 25,000+/mo, or needs a corridor not yet integrated | Custom negotiated rate | Custom negotiated rate | Dedicated, SLA-backed |

A "transaction" is one payment or refund attempt that reaches a final `success` state. Messaging is
billed per delivered message (SMS, WhatsApp, or email), independent of the payment volume band —
an app can be Growth-tier on payments and still send high messaging volume without being forced
into Scale.

## What it actually costs — worked examples

These use the real per-provider fees already configured in the routing engine
(`packages/providers/src/registry.ts`, mirrored in `docs/architecture/PAYMENT_ARCHITECTURE.md`), so
the math below is grounded, not hypothetical.

**ReachChurch — Growth tier, mobile money donations via Flutterwave (Nigeria)**
500 donations/month, averaging $50 each = $25,000 processed.
- Provider fee (Flutterwave mobile money, 1.0%): $250
- Platform fee (Growth, 0.5% + $0.05 × 500): $125 + $25 = $150
- **Total: $400/month — a 1.6% all-in rate**

**HaulPro — Scale tier, card payments via Stripe**
5,000 transactions/month, averaging $80 each = $400,000 processed.
- Provider fee (Stripe, 2.9% + $0.30 × 5,000): $11,600 + $1,500 = $13,100
- Platform fee (Scale, 0.3% + $0.03 × 5,000): $1,200 + $150 = $1,350
- **Total: $14,450/month — a 3.6% all-in rate, almost entirely Stripe's own card-network cost, not BIS's margin**

**AfriBook — Growth tier, SMS via SignalHouse**
10,000 messages/month.
- Carrier cost (SignalHouse, $0.005/dispatch): $50
- Platform fee (Growth, $0.01/message): $100
- **Total: $150/month — $0.015 per message all-in**

The second example is the important one to sit with: BIS's own fee is a small fraction of the
total cost on card payments, because Stripe's interchange-driven rate dominates. The platform's
real pricing lever is which rail it routes to (a Nigerian mobile-money donation through Flutterwave
costs the customer roughly a third of what the same donation would cost through a card network),
not the platform fee itself. That routing decision is the product's actual value proposition.

## Enterprise

Not a fixed number by design — this tier exists for customers whose shape doesn't fit the self-serve
bands: dedicated corridor onboarding (a provider not yet in the registry), a minimum-commitment
contract in exchange for a lower flat rate, custom SLA on failover time and support response, or
BAA/compliance paperwork. Price this deal-by-deal once there's a real prospect asking.

## Open questions for the business to decide

- **Minimum monthly commitment.** None proposed on Growth/Scale (pure usage-based, matching the
  target market of SMB/nonprofit apps with uneven volume). Enterprise likely wants one — a number
  requires knowing what "dedicated support" actually costs to staff.
- **Chargebacks and disputes.** Not addressed here. Card-network dispute fees are typically passed
  through at the provider's own rate; decide whether BIS adds anything on top.
- **Annual/committed-use discounts.** Not modeled. Common in this market once a customer's monthly
  spend is predictable.
- **Does test-mode traffic ever need a rate limit tighter than the platform default?** Currently
  gated by the existing `RateLimiter` middleware, not a hard monthly cap — confirm that's
  sufficient to prevent free-tier abuse before this goes live.
- **The percentages themselves.** Pressure-test 0.5%/0.3% platform-fee bands against actual Neon,
  hosting, and support cost once there's real production volume to model against — these are a
  reasoned starting point, not a validated margin.
