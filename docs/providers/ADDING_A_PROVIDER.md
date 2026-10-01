# Adding a New Provider

The authoritative, current process for adding a new payment or messaging
provider adapter to this platform. Supersedes ADR-005's original "Adding a
New Provider" section, which had drifted from the implementation (see the
amendment notes in `docs/adr/ADR-005-provider-adapters.md`) — that ADR
still explains *why* this pattern was chosen; this doc explains *how* to
use it today.

This is a code + operations checklist. A provider isn't "added" once it
compiles — it's added once an admin can turn it on through the console
without a deploy, and once it fails loudly (not silently) if misconfigured.

---

## 0. Verify the provider's real API first — never fabricate

Before writing any code: confirm the provider's actual authentication
scheme, endpoint, request/response shape, and error format against a real
source — their published API docs, a live sandbox account, or documentation
supplied directly by whoever asked for the integration. If you cannot
verify a detail (no live account, docs behind a login you don't have,
nothing findable), say so explicitly in the adapter's own comments and in
your PR/commit — don't guess and present it as verified. Several existing
adapters document exactly this distinction inline (e.g. `vibes.ts`'s class
comment flags lower-confidence, search-snippet-derived details that should
not be trusted until verified against a live sandbox). A provider that
can't be verified at all (no real API, or turns out not to actually offer
the capability you need — see the Trembi investigation in
`docs/IMPLEMENTATION_CHANGELOG.md`) should be reported as such, not built
anyway.

---

## 1. Create the adapter class

**Location**: `packages/providers/src/adapters/{payments,messaging,other}/<provider-id>.ts`

Extend `BaseProvider` (`packages/providers/src/base.ts`):

```typescript
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

export class MoMoPayProvider extends BaseProvider {
  // One getter per credential field. The field name here (the object key
  // read off `this.secrets`) is what both the admin console's Add Secret
  // form and ProviderRegistry.addSecret() need to match exactly — see
  // step 4 below. Falls back to a process.env var so the provider also
  // works from plain environment configuration with no admin-console step
  // at all (documented in .env.example — step 3).
  private get apiKey(): string {
    return this.secrets.api_key || process.env.MOMOPAY_API_KEY || '';
  }

  // Declares whether this adapter currently has what it needs to make a
  // real API call — reuse the exact same fields your real request path
  // checks before falling back to simulated (see below), nothing more.
  // This is what the admin console's "Configured" / "Not Configured"
  // badge and the startup log warning (ProviderRegistry's
  // warnUnconfiguredLiveProviders()) are driven by. The BaseProvider
  // default is `true` (correct for a simulation-only adapter with no real
  // credentials to check) — override it once you add a real HTTP call.
  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async processRequest(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    this.verifyAvailability(); // throws if status is offline/maintenance

    const { amount, currency, paymentToken } = payload;

    // The established fallback pattern across every real adapter in this
    // repo: no credentials, or nothing to charge/send (e.g. no
    // paymentToken — this gateway never collects raw card data itself),
    // means simulate rather than fabricate a real-looking failure or a
    // fake success. Never call the real API with something you can't
    // actually authenticate or process.
    if (!this.apiKey || !paymentToken) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    const startTime = Date.now();
    try {
      const res = await this.http_request({
        method: 'POST',
        url: 'https://api.momopay.example/v1/charges',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: { amount, currency, token: paymentToken },
      });
      // ... map the real response to a TransactionEvent. Use 'unknown'
      // (not 'failed') for a genuinely ambiguous outcome — see
      // TransactionStatus's doc comment in packages/schemas/src/index.ts.
    } catch (err: any) {
      // ... return a 'failed' TransactionEvent with err.message.
    }
  }

  private async simulatedProcess(/* ... */): Promise<TransactionEvent> {
    // Mirror any existing adapter's simulatedProcess() for the shape —
    // e.g. packages/providers/src/adapters/payments/stripe.ts.
  }
}
```

Multi-field credentials (e.g. Airwallex needs `client_id` **and**
`api_key`; Africa's Talking needs `api_key` **and** `username`) are just
multiple getters — `isConfigured()` then requires all of them:

```typescript
public isConfigured(): boolean {
  return Boolean(this.clientId) && Boolean(this.apiKey);
}
```

An optional field with a working default (e.g. NMI's `gateway_id`, which
falls back to `secure.nmi.com`) should **not** be part of `isConfigured()`
— only include fields the adapter cannot function without.

---

## 2. Register it

**File**: `packages/providers/src/registry.ts`

Import the class and add a `this.register(...)` call inside
`initializeProviders()`, following any existing entry for the pattern
(id, display name, category, starting weight/latency/fees, and the
management defaults — environment/countries/currencies/capabilities). No
other registry code needs to change: capability-based routing
(`findByCategoryAndCapabilities`), the webhook route, health checks, and
the admin console's provider list all work generically off whatever's
registered here.

`environment: 'live'` makes a provider eligible for real production
traffic; `environment: 'test'` (like the two `example-*` adapters) keeps
it available in dev/staging but excluded from production routing
(`ProviderRegistry.findByCategoryAndCapabilities` filters `test`-only
providers out when `NODE_ENV === 'production'`). Don't mark a new,
not-yet-verified adapter `'live'` until you're confident in it.

---

## 3. Document the env var(s)

Add the `process.env.*` var(s) your adapter reads to the root
**`.env.example`**, in the same style as the existing entries — a short
comment noting anything a future integrator needs to know (sandbox vs.
live URLs, region quirks, rate limits worth knowing up front).

---

## 4. Wire up admin-console secret configuration

An admin can configure real credentials for a `'live'` provider through
the console **without a deploy** — but only if the console knows which
field names your adapter expects. Add an entry to
`PROVIDER_SECRET_FIELDS` in
`apps/admin-console/src/components/ProviderManagement.tsx`:

```typescript
momopay: [{ field: 'api_key', label: 'API Key' }],
```

The `field` value must exactly match the key your adapter's getter reads
off `this.secrets` (step 1). Skipping this step doesn't break anything —
the Add Secret form falls back to a free-text field input for providers
not in the map — but it means an admin has to already know your internal
field name rather than being guided to it.

**How this actually reaches your adapter at runtime**: when an admin adds
or deletes a secret through `/api/dashboard/providers/:id/secrets`,
`ProviderRegistry.addSecret()`/`deleteSecret()` rebuild a
`{ field: value }` record from everything currently stored for that
provider and call `provider.setSecrets(record)` — the *same* provider
instance your adapter's `processRequest()` runs on. The change is live on
the very next request; nothing needs to restart. (Before 2026-09-15, this
wiring didn't exist at all — see `docs/IMPLEMENTATION_CHANGELOG.md` — so
if you're referencing older code or docs for how this works, don't trust
them.)

**Does it survive a gateway restart?** As of 2026-09-17, yes. The gateway
(`services/api-gateway/src/app.ts`) calls
`registry.exportSecretsForPersistence(id)` after every successful add/
delete and stores the full set, AES-256-GCM encrypted, in the
`provider_configs` table — automatically, nothing your adapter or this
step needs to do anything for. It reads the same way at startup via
`registry.hydrateSecrets(id, secrets)`, before any real request can reach
your adapter. This is skipped (not an error) whenever
`SECRET_ENCRYPTION_KEY` isn't set, which is most non-production
environments — the process.env fallback you built in step 1 is exactly
what covers that gap, same as before this existed.

---

## 5. Write tests

Co-locate `<provider-id>.test.ts` next to the adapter (the convention
every existing adapter follows — not a `__tests__/` subfolder). At minimum:

- **Without credentials configured**: falls back to simulated, makes no
  real HTTP call (assert on a stubbed `fetch` never being invoked).
- **With credentials but nothing to process** (e.g. no `paymentToken`):
  still simulated.
- **Real HTTP path**: stub `fetch`, assert the request URL/method/
  headers/body match the provider's real documented contract, and that a
  realistic success/failure/ambiguous response maps to the right
  `TransactionEvent.status`.
- **Retry behavior**: a 5xx/429 response is retried (via
  `BaseProvider.http_request`'s built-in retry) and eventually reports
  failure if every attempt fails.
- **`isConfigured()`**: false with no credentials; true once set via env
  var; true once set via `provider.setSecrets({...})` (proves the admin
  console path, not just the env var path, actually works).

See any existing adapter's test file (e.g.
`packages/providers/src/adapters/payments/stripe.test.ts`) for the
established shape and helpers.

---

## 6. Inbound webhooks — native-first, with a generic fallback

`POST /v1/api/webhooks/:provider` (`services/api-gateway/src/app.ts`) is
generic by code — any provider id registered in step 2 can receive webhooks
there with zero gateway changes — and, as of this pass, generic by protocol
too: it calls `known.verifyProviderWebhookSignature(rawBody, headers)` on
your adapter first, and only falls back to the shared, platform-wide
`x-webhook-signature` HMAC-SHA256 (`WEBHOOK_HMAC_SECRET`) check when that
returns `null` (meaning "no native scheme configured/available", not "the
signature failed"). A native check that returns `false` rejects the
delivery outright — it never falls through to the weaker generic check.

**To add native verification for your provider:**

1. Look up your provider's real webhook signing scheme (header name(s),
   algorithm, what exactly gets signed) — verify it against current
   documentation the same way you verified the payment API in step 0. Do
   not guess or reuse another provider's scheme "because it's probably
   similar" — Stripe, NMI, Flutterwave, PayChangu, and Airwallex all turned
   out to differ in some way (timestamp vs. nonce, separator vs. none,
   computed HMAC vs. a static echoed value) despite looking superficially
   alike.
2. Add a `private get webhookSecret()` (or similarly named) getter reading
   `this.secrets.webhook_secret || process.env.YOUR_PROVIDER_WEBHOOK_SECRET`
   — reuse the `webhook_secret` field name so it fits the existing
   admin-console secret UI and `ProviderSecretMeta` contract; add a new env
   var name in `.env.example` and document it in your adapter's file-level
   comment.
3. Override `verifyProviderWebhookSignature(rawBody, headers)`:
   `return null` when your webhook secret isn't configured (defer to the
   generic fallback); `return false` when the header is missing or doesn't
   match; `return true` when it does. See
   `packages/providers/src/adapters/payments/stripe.ts` (timestamped HMAC
   with a replay window), `nmi.ts` (nonce-keyed HMAC), `flutterwave.ts`
   (static value comparison, not an HMAC), or `airwallex.ts`
   (no-separator concatenation) for the range of real shapes this can
   take.
4. Add `webhook_secret` to your provider's entry in `PROVIDER_SECRET_FIELDS`
   in `apps/admin-console/src/components/ProviderManagement.tsx` so an
   operator has a field to enter it.
5. Write tests mirroring the `describe('verifyProviderWebhookSignature()', ...)`
   blocks in the existing adapter `*.test.ts` files: null when unconfigured,
   true for a correctly computed signature, false for a tampered body and
   for a missing header.

If your provider's real scheme is something this platform genuinely
shouldn't attempt without a live sandbox to validate against (see
`pawapay.ts` for PawaPay's RFC-9421 asymmetric signatures as the precedent),
document that decision in your adapter's file-level comment instead of
guessing — the generic fallback is a legitimate, honest degrade, a wrong
implementation is not.

See `docs/DEVELOPER_GUIDE.md` §9a for the customer-facing version of this
same explanation.

---

## 7. Checklist

- [ ] Verified the provider's real API contract (or explicitly flagged
      what couldn't be verified)
- [ ] Adapter class extends `BaseProvider`, implements `processRequest()`
      with a simulated fallback
- [ ] `isConfigured()` overridden to check the real required credential
      field(s)
- [ ] Registered in `packages/providers/src/registry.ts`
      (`environment: 'test'` until verified)
- [ ] Env var(s) documented in root `.env.example`
- [ ] Secret field(s) added to `PROVIDER_SECRET_FIELDS` in
      `apps/admin-console/src/components/ProviderManagement.tsx`
- [ ] Tests: simulated fallback, real HTTP path, retry, `isConfigured()`
- [ ] If inbound webhooks matter for this provider: read §6 above and
      note the gap (or close it) rather than assuming it's handled
- [ ] `npm run type-check && npm test && npm run lint && npm run build:all`
      all clean
