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

## 6. Inbound webhooks — read this before assuming it "just works"

`POST /v1/api/webhooks/:provider` (`services/api-gateway/src/app.ts`) is
**generic by code** — any provider id registered in step 2 can receive
webhooks there with zero gateway changes — but it is **not generic by
protocol**. Every inbound webhook, regardless of provider, is verified
against one shared, platform-wide `x-webhook-signature` HMAC-SHA256 header
keyed by `WEBHOOK_HMAC_SECRET`. It does **not** verify your provider's own
native webhook signature scheme (e.g. a real Stripe `Stripe-Signature`
header, a real Flutterwave `verif-hash`). If your provider needs to
deliver real inbound webhooks, either:

- the provider supports configuring its own outbound signing to match
  this platform's HMAC scheme (rare), or
- something upstream of this endpoint re-signs the delivery with
  `WEBHOOK_HMAC_SECRET` before forwarding it here, or
- you extend the route with real per-provider native verification (not
  built today — this is a known, open gap, not a design you should assume
  exists).

See `docs/DEVELOPER_GUIDE.md` §9a for the customer-facing version of this
same caveat.

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
