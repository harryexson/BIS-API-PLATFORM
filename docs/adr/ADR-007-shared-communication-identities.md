# ADR-007: Shared Communication Identities

**Status**: Accepted  
**Date**: 2026-08-16  
**Authors**: Platform Team  
**Deciders**: Engineering Lead, Product Team

---

## Context

Multiple client applications (ReachChurch, HaulPro, STAYSCAPE, Ride-ly, etc.) send messages to their users via the platform's messaging router. Each application has its own brand identity, but they all share the same underlying messaging provider accounts.

This creates a design question: **Should each app send messages from its own sender identity (phone number, email address, sender name), or from a shared platform identity?**

Additionally, outbound payment operations carry a merchant descriptor visible to the end customer on their bank statement. Should all apps share a single merchant descriptor, or have unique ones?

---

## Problem Statement

### Scenario A: Shared Identity
- All SMS sent from: `+1-800-COMPANY`
- All emails sent from: `notifications@company.com`
- All merchant descriptors: `COMPANY PAYMENTS`

User receives SMS: "Your Ride-ly driver is 5 minutes away" — from `+1-800-COMPANY`

### Scenario B: Per-App Identity
- Ride-ly SMS sent from: `+1-888-RIDELY`
- ReachChurch SMS from: `REACHCHURCH` (alphanumeric sender)
- HaulPro emails from: `notifications@haulpro.app`

User receives SMS: "Your Ride-ly driver is 5 minutes away" — from `RIDELY`

---

## Options Considered

### 1. Fully Shared — Single identity for all apps
All messaging and payments originate from platform-level identities.

### 2. Fully Isolated — Each app registers its own provider accounts
Each app has its own Stripe account, its own Infobip sender, etc. Platform becomes a thin proxy.

### 3. Hybrid — Shared provider accounts, per-app sender identities (selected)
Platform maintains the provider relationships (billing, API keys, rate limits). Within those relationships, each app configures its own sender identity (Alphanumeric sender ID, email from address, payment descriptor).

---

## Decision

**Hybrid model: shared provider accounts with per-application messaging identities and payment descriptors.**

---

## Implementation

### Messaging Identities

Each application record in the `applications` table includes messaging identity configuration:

```typescript
interface ApplicationMessagingConfig {
  smsFromNumber?: string;        // '+12015551234' — dedicated number if purchased
  smsAlphanumericId?: string;    // 'RIDELY' — not available in all countries
  emailFromAddress: string;      // 'noreply@ridely.app'
  emailFromName: string;         // 'Ride-ly'
  whatsappDisplayName?: string;  // 'Ride-ly Support'
}
```

When the messaging router dispatches a message for Ride-ly:
1. Retrieve Ride-ly's `ApplicationMessagingConfig` from DB
2. Pass `fromNumber`, `fromAddress`, `fromName` to the provider adapter
3. Provider sends message with Ride-ly's identity (not the platform's generic identity)

### Payment Descriptors

```typescript
interface ApplicationPaymentConfig {
  merchantDescriptor: string;    // 'RIDELY*TRIP' — appears on bank statement
  statementDescriptorSuffix?: string; // Appended to base descriptor (Stripe)
}
```

### Fallback

If an app has no custom messaging identity configured, the platform default is used:
- SMS from: platform default number
- Email from: `notifications@platform.company.com`

---

## Rationale

### Against Fully Shared
- Brand identity is critical for user trust. "COMPANY PAYMENTS" on a bank statement is confusing for ReachChurch users making donations.
- Regulatory: In some jurisdictions, the sender ID must match the brand name the customer knows.
- Deliverability: Shared email sender domain reputation affects all apps if one app's messages cause spam complaints.

### Against Fully Isolated
- Requires each app to set up its own Stripe account, Infobip account, etc. — massive onboarding friction.
- Platform loses the ability to negotiate volume pricing across all apps.
- Circuit breaker and routing logic would need to know which provider account to use per app, adding significant complexity.

### For Hybrid
- Platform maintains the provider relationships (one billing account, volume rates, API key management).
- Each app customizes the visible sender identity without affecting provider relationships.
- Sender identity is data (in the database), not code — new apps get their own identity on registration.

---

## Consequences

**Positive**
- Users see brand-appropriate sender names/numbers/descriptors
- Platform manages all provider billing centrally
- Volume pricing benefits all apps collectively
- Adding a new app requires only a DB record, not a new provider account

**Negative**
- Shared provider account means shared rate limits — one app sending a mass notification can exhaust SMS rate limits for all apps (mitigated: per-app rate limiting at gateway level)
- If one app's email domain is flagged for spam, all email from that domain is affected (mitigated: per-app email subdomains recommended)
- Provider approval required for alphanumeric sender IDs, WhatsApp Business names — these take time to provision per app

---

## Alphanumeric Sender ID Registration (Action Required)

Alphanumeric sender IDs (e.g., `RIDELY`) must be pre-registered with messaging providers and approved by telecom regulators in target countries. This is a manual, one-time process per app per country.

See [DEPLOYMENT.md](../operations/DEPLOYMENT.md) for the registration procedure.
