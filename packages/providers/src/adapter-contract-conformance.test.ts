import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ProviderRegistry,
  ProviderNotConfiguredError,
  type ProviderStateStore,
} from './index';

/**
 * Phase 26 — provider adapter contract conformance (gap register E11, E2
 * messaging side / E3, E8 residual, E4 re-verification).
 *
 * House style (see payment-identity-and-killswitch.test.ts): `fetch` is
 * stubbed and every outgoing request the adapter actually made is captured
 * and asserted on — the URL (host), headers and body — never just the
 * returned status. No test here contacts a real provider.
 *
 * Every test uses ProviderRegistry.createIsolatedInstance(): adapters are
 * registered exactly the way production registers them (that is the point
 * of E11 — the bug only existed on the registry path; every adapter unit
 * test passed `environment` into the adapter's config by hand).
 */

type Captured = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function captureFetch(respond: (url: string) => Response | Promise<Response> = () => json({})) {
  const calls: Captured[] = [];
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? 'GET'),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return respond(url);
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

// ---------------------------------------------------------------------------
// E11 — live/sandbox host selection follows the REGISTERED environment
// ---------------------------------------------------------------------------

interface HostCase {
  id: string;
  secrets: Record<string, string>;
  payload: Record<string, unknown>;
  liveHost: string;
  sandboxHost: string;
  aux?: (url: string) => Response | undefined;
}

const HOST_CASES: HostCase[] = [
  {
    id: 'braintree',
    secrets: { public_key: 'pub', private_key: 'priv', merchant_id: 'mid' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'fake-valid-nonce' },
    liveHost: 'https://payments.braintree-api.com/',
    sandboxHost: 'https://payments.sandbox.braintree-api.com/',
  },
  {
    id: 'paypal',
    secrets: { client_id: 'cid', client_secret: 'csec' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' },
    liveHost: 'https://api-m.paypal.com/',
    sandboxHost: 'https://api-m.sandbox.paypal.com/',
    aux: (u) => (u.endsWith('/v1/oauth2/token') ? json({ access_token: 'A21', expires_in: 32400 }) : undefined),
  },
  {
    id: 'square',
    secrets: { access_token: 'sq_tok' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon:card-nonce-ok' },
    liveHost: 'https://connect.squareup.com/',
    sandboxHost: 'https://connect.squareupsandbox.com/',
  },
  {
    id: 'adyen',
    secrets: { api_key: 'AQE_x', merchant_account: 'MerchantECOM', live_url_prefix: 'bisapitest' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_pm_1' },
    liveHost: 'https://bisapitest-checkout-live.adyenpayments.com/',
    sandboxHost: 'https://checkout-test.adyen.com/',
  },
  {
    id: 'authorizenet',
    secrets: { login_id: 'login', transaction_key: 'txkey' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'accept_js_nonce' },
    liveHost: 'https://api.authorize.net/',
    sandboxHost: 'https://apitest.authorize.net/',
  },
  {
    id: 'checkout',
    secrets: { api_key: 'sk_x' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_real_customer' },
    liveHost: 'https://api.checkout.com/',
    sandboxHost: 'https://api.sandbox.checkout.com/',
  },
  {
    id: 'pawapay',
    secrets: { api_key: 'pawa_key' },
    payload: { amount: 1000, currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567', metadata: { pawapayProvider: 'AIRTEL_MWI' } },
    liveHost: 'https://api.pawapay.io/',
    sandboxHost: 'https://api.sandbox.pawapay.io/',
  },
  {
    id: 'airwallex',
    secrets: { client_id: 'awx_c', api_key: 'awx_k' },
    payload: { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'cst_consent_1', metadata: { airwallexCustomerId: 'cus_1' } },
    liveHost: 'https://api.airwallex.com/',
    sandboxHost: 'https://api-demo.airwallex.com/',
    aux: (u) =>
      u.endsWith('/authentication/login')
        ? json({ token: 'awx_token', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() })
        : u.endsWith('/payment_intents/create')
          ? json({ id: 'int_awx_1', status: 'REQUIRES_PAYMENT_METHOD' })
          : undefined,
  },
  {
    id: 'africastalking',
    secrets: { api_key: 'at_key', username: 'bisplatform' },
    payload: { recipient: '+254700000001', content: 'Your code is 123456' },
    liveHost: 'https://api.africastalking.com/',
    sandboxHost: 'https://api.sandbox.africastalking.com/',
  },
];

async function callThroughRegistry(registry: ProviderRegistry, c: HostCase): Promise<Captured[]> {
  const provider = registry.getProvider(c.id)!;
  provider.setSecrets(c.secrets);
  const calls = captureFetch((url) => c.aux?.(url) ?? json({}));
  await provider.processRequest('app_p26', { paymentTransactionId: randomUUID(), ...c.payload } as never, 'phase26');
  return calls;
}

describe("Phase 26 — E11: an adapter registered 'live' really calls its LIVE host", () => {
  it('every adapter config carries the same environment the registry routes it as (all 28 providers)', () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    for (const view of registry.getAllManagementViews()) {
      expect({ id: view.id, env: registry.getProvider(view.id)!.config.environment }).toEqual({ id: view.id, env: view.environment });
    }
  });

  for (const c of HOST_CASES) {
    it(`${c.id}: registered 'live' → every outgoing request goes to ${c.liveHost} (never the sandbox)`, async () => {
      const registry = ProviderRegistry.createIsolatedInstance();
      expect(registry.getManagementView(c.id)!.environment).toBe('live');

      const calls = await callThroughRegistry(registry, c);

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.url.startsWith(c.liveHost)).toBe(true);
        expect(call.url.startsWith(c.sandboxHost)).toBe(false);
      }
    });

    it(`${c.id}: switched to 'test' via updateManagement → every request goes to ${c.sandboxHost}`, async () => {
      const registry = ProviderRegistry.createIsolatedInstance();
      registry.updateManagement(c.id, { environment: 'test' });

      const calls = await callThroughRegistry(registry, c);

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.url.startsWith(c.sandboxHost)).toBe(true);
    });
  }

  it('an environment loaded from the persisted store (syncFromStore — another replica/admin wrote it) reaches the adapter too', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const store: ProviderStateStore = {
      async loadAll() {
        return [await this.load('square')].filter((r): r is NonNullable<typeof r> => r !== null);
      },
      async load(slug) {
        if (slug !== 'square') return null;
        return { slug, managementVersion: 1, management: { environment: 'test' }, secretsVersion: 0, readSecrets: () => [] };
      },
      async saveManagement() {
        return { saved: false };
      },
      async saveSecrets() {
        return { saved: false };
      },
    };
    expect(registry.getProvider('square')!.config.environment).toBe('live');
    await registry.syncFromStore(store);
    expect(registry.getManagementView('square')!.environment).toBe('test');

    const calls = await callThroughRegistry(registry, HOST_CASES.find((c) => c.id === 'square')!);
    expect(calls.map((c) => c.url)).toEqual(['https://connect.squareupsandbox.com/v2/payments']);
  });

  it('updateProviderConfig (the admin PATCH path) cannot make the host and the routed environment diverge', () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    registry.updateProviderConfig('paypal', { environment: 'test' });
    expect(registry.getProvider('paypal')!.config.environment).toBe('test');
    expect(registry.getManagementView('paypal')!.environment).toBe('test');

    // A malformed value never leaves the adapter on an environment it is not routed as.
    registry.updateProviderConfig('paypal', { environment: 'staging' as never });
    expect(registry.getProvider('paypal')!.config.environment).toBe('test');
    expect(registry.getManagementView('paypal')!.environment).toBe('test');
  });

  it('PayPal never reuses a sandbox OAuth token against the live host after an environment change', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const c = HOST_CASES.find((x) => x.id === 'paypal')!;
    registry.updateManagement('paypal', { environment: 'test' });
    await callThroughRegistry(registry, c);
    registry.updateManagement('paypal', { environment: 'live' });
    const calls = await callThroughRegistry(registry, c);
    expect(calls[0].url).toBe('https://api-m.paypal.com/v1/oauth2/token');
  });

  describe("Adyen registered 'live' with no live URL prefix", () => {
    const secrets = { api_key: 'AQE_x', merchant_account: 'MerchantECOM' };
    const payload = { paymentTransactionId: randomUUID(), amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_pm_1' };

    it('is not configured, and in production refuses with NO request to any host (it used to silently call checkout-test.adyen.com)', async () => {
      const registry = ProviderRegistry.createIsolatedInstance();
      const adyen = registry.getProvider('adyen')!;
      adyen.setSecrets(secrets);
      expect(adyen.isConfigured()).toBe(false);

      const calls = captureFetch();
      process.env.NODE_ENV = 'production';
      const err = await adyen.processRequest('app_p26', payload as never, 'phase26').catch((e) => e);
      expect(err).toBeInstanceOf(ProviderNotConfiguredError);
      expect((err as ProviderNotConfiguredError).missing).toEqual(['ADYEN_LIVE_URL_PREFIX']);
      expect(calls).toHaveLength(0);

      const refundErr = await adyen
        .refund('app_p26', { originalTransactionId: 'psp_1', amount: 5, currency: 'USD' } as never, 'phase26')
        .catch((e) => e);
      expect(refundErr).toBeInstanceOf(ProviderNotConfiguredError);
      expect(calls).toHaveLength(0);
    });

    it("registered 'test', the test host is used even when a live prefix is configured", async () => {
      const registry = ProviderRegistry.createIsolatedInstance();
      registry.updateManagement('adyen', { environment: 'test' });
      const adyen = registry.getProvider('adyen')!;
      adyen.setSecrets({ ...secrets, live_url_prefix: 'bisapitest' });
      const calls = captureFetch();
      await adyen.processRequest('app_p26', payload as never, 'phase26');
      expect(calls.map((c) => c.url)).toEqual(['https://checkout-test.adyen.com/v71/payments']);
    });
  });
});

// ---------------------------------------------------------------------------
// E8 residual — real instrument forwarded AND correct host, together
// ---------------------------------------------------------------------------

describe("Phase 26 — E8 residual: AuthorizeNet / Checkout.com / Paystack registered 'live' charge the REAL instrument on the LIVE host", () => {
  const prevSandbox = process.env.AUTHORIZENET_SANDBOX;
  afterEach(() => {
    if (prevSandbox === undefined) delete process.env.AUTHORIZENET_SANDBOX;
    else process.env.AUTHORIZENET_SANDBOX = prevSandbox;
  });

  it('AuthorizeNet: the Accept.js nonce goes out as opaqueData to api.authorize.net — no 4111 test card, no apitest host', async () => {
    delete process.env.AUTHORIZENET_SANDBOX; // the old default → sandbox
    const registry = ProviderRegistry.createIsolatedInstance();
    const anet = registry.getProvider('authorizenet')!;
    anet.setSecrets({ login_id: 'login', transaction_key: 'txkey' });
    const calls = captureFetch(() => json({ transactionResponse: { responseCode: '1', transId: '60001' }, messages: { resultCode: 'Ok', message: [] } }));

    await anet.processRequest('app_p26', { paymentTransactionId: randomUUID(), amount: 12.5, currency: 'USD', paymentMethod: 'card', paymentToken: 'eyJjb2RlIjoiNTBf_REAL_NONCE' } as never, 'phase26');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.authorize.net/xml/v1/request.api');
    const body = calls[0].body!;
    expect(body).toContain('"dataValue":"eyJjb2RlIjoiNTBf_REAL_NONCE"');
    expect(body).toContain('COMMON.ACCEPT.INAPP.PAYMENT');
    expect(body).not.toContain('4111111111111111');
  });

  it('Checkout.com: the customer token goes out as source.token to api.checkout.com — no tok_test', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const cko = registry.getProvider('checkout')!;
    cko.setSecrets({ api_key: 'sk_live_like' });
    const calls = captureFetch(() => json({ id: 'pay_1', approved: true, status: 'Authorized' }, 201));

    await cko.processRequest('app_p26', { paymentTransactionId: randomUUID(), amount: 20, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_4gzeau5o2uqubbk6fufs3m7p54' } as never, 'phase26');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.checkout.com/payments');
    const body = JSON.parse(calls[0].body!);
    expect(body.source).toEqual({ type: 'token', token: 'tok_4gzeau5o2uqubbk6fufs3m7p54' });
    expect(calls[0].body).not.toContain('tok_test');
  });

  it('Paystack: the customer email goes out to api.paystack.co (single host for test and live) — no fabricated @bis-platform.invalid address', async () => {
    const registry = ProviderRegistry.createIsolatedInstance();
    const ps = registry.getProvider('paystack')!;
    ps.setSecrets({ api_key: 'sk_live_like' });
    const calls = captureFetch(() => json({ status: true, data: { reference: 'r1', authorization_url: 'https://checkout.paystack.com/r1' } }));

    await ps.processRequest('app_p26', { paymentTransactionId: randomUUID(), amount: 5000, currency: 'NGN', paymentMethod: 'card', metadata: { email: 'donor@example.org' } } as never, 'phase26');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.paystack.co/transaction/initialize');
    const body = JSON.parse(calls[0].body!);
    expect(body.email).toBe('donor@example.org');
    expect(calls[0].body).not.toContain('bis-platform.invalid');
  });
});

// ---------------------------------------------------------------------------
// E3 / E2 (messaging side) — no fabricated delivery in production
// ---------------------------------------------------------------------------

const SIMULATION_ONLY_MESSAGING = ['signalhouse', 'infobip', 'futuresms', 'email', 'example-msg'];
const REAL_MESSAGING_UNCONFIGURED = ['twilio', 'whatsapp', 'vonage', 'africastalking', 'sinch', 'vibes'];
const MESSAGING_ENV_VARS = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
  'VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_FROM_NUMBER',
  'AFRICASTALKING_API_KEY', 'AFRICASTALKING_USERNAME',
  'SINCH_API_TOKEN', 'SINCH_SERVICE_PLAN_ID',
  'VIBES_USERNAME', 'VIBES_PASSWORD',
];

describe('Phase 26 — E3 / E2 messaging side: a messaging adapter never fabricates a delivered message in production', () => {
  const saved: Record<string, string | undefined> = {};
  const clearEnv = () => {
    for (const k of MESSAGING_ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  };
  afterEach(() => {
    for (const k of MESSAGING_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const message = { recipient: '+265991234567', content: 'Your one-time code is 482913' };

  for (const id of [...SIMULATION_ONLY_MESSAGING, ...REAL_MESSAGING_UNCONFIGURED]) {
    it(`${id}: NODE_ENV=production → ProviderNotConfiguredError, no HTTP call, no 'success'`, async () => {
      clearEnv();
      const registry = ProviderRegistry.createIsolatedInstance();
      const provider = registry.getProvider(id)!;
      const calls = captureFetch();
      process.env.NODE_ENV = 'production';

      const outcome = await provider.processRequest('app_p26', message as never, 'phase26').catch((e) => e);

      expect(outcome).toBeInstanceOf(ProviderNotConfiguredError);
      expect((outcome as ProviderNotConfiguredError).ambiguous).toBe(false); // definite non-send → router may fail over
      expect(calls).toHaveLength(0);
    });

    it(`${id}: outside production the labelled simulation still works (dev/test unchanged)`, async () => {
      clearEnv();
      const registry = ProviderRegistry.createIsolatedInstance();
      const calls = captureFetch();
      process.env.NODE_ENV = 'test';
      const event = await registry.getProvider(id)!.processRequest('app_p26', message as never, 'phase26');
      expect(event.status).toBe('success');
      expect(calls).toHaveLength(0);
    });
  }

  it("isConfigured() no longer lies: simulation-only adapters and an unconfigured Twilio report false; Twilio with all 3 credentials reports true", () => {
    clearEnv();
    const registry = ProviderRegistry.createIsolatedInstance();
    for (const id of SIMULATION_ONLY_MESSAGING) {
      expect({ id, configured: registry.getProvider(id)!.isConfigured() }).toEqual({ id, configured: false });
      expect(registry.getManagementView(id)!.configured).toBe(false);
    }
    const twilio = registry.getProvider('twilio')!;
    expect(twilio.isConfigured()).toBe(false);
    twilio.setSecrets({ account_sid: 'AC123', auth_token: 'tok' });
    expect(twilio.isConfigured()).toBe(false); // needs a sender too
    twilio.setSecrets({ account_sid: 'AC123', auth_token: 'tok', from_number: '+15005550006' });
    expect(twilio.isConfigured()).toBe(true);
  });

  it('a CONFIGURED real adapter is untouched by the kill-switch in production: Twilio really POSTs to api.twilio.com', async () => {
    clearEnv();
    const registry = ProviderRegistry.createIsolatedInstance();
    const twilio = registry.getProvider('twilio')!;
    twilio.setSecrets({ account_sid: 'AC123', auth_token: 'tok', from_number: '+15005550006' });
    const calls = captureFetch(() => json({ sid: 'SM1', status: 'queued' }, 201));
    process.env.NODE_ENV = 'production';

    const event = await twilio.processRequest('app_p26', message as never, 'phase26');

    expect(event.status).toBe('success');
    expect(event.id).toBe('SM1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(calls[0].body).toContain('To=%2B265991234567');
  });
});

// ---------------------------------------------------------------------------
// E4 — re-verification with the adapter's REAL internal timer
// ---------------------------------------------------------------------------

interface AmbiguityCase {
  id: string;
  secrets: Record<string, string>;
  payload: Record<string, unknown>;
  isCharge(url: string): boolean;
  aux?(url: string): Response | undefined;
}

const MONEY_MOVING: AmbiguityCase[] = [
  { id: 'stripe', secrets: { api_key: 'sk_test_x' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_visa' }, isCharge: (u) => u.endsWith('/v1/payment_intents') },
  { id: 'adyen', secrets: { api_key: 'AQE_x', merchant_account: 'M', live_url_prefix: 'bisapitest' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_pm_1' }, isCharge: (u) => u.endsWith('/v71/payments') },
  { id: 'nmi', secrets: { api_key: 'nmi_key' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'collectjs_tok' }, isCharge: (u) => u.endsWith('/api/transact.php') },
  { id: 'paypal', secrets: { client_id: 'cid', client_secret: 'csec' }, payload: { currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' }, isCharge: (u) => u.endsWith('/v2/checkout/orders'), aux: HOST_CASES.find((c) => c.id === 'paypal')!.aux },
  { id: 'square', secrets: { access_token: 'sq_tok' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon:ok' }, isCharge: (u) => u.endsWith('/v2/payments') },
  { id: 'checkout', secrets: { api_key: 'sk_x' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_x' }, isCharge: (u) => u.endsWith('/payments') },
  { id: 'braintree', secrets: { public_key: 'p', private_key: 'q', merchant_id: 'm' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'nonce' }, isCharge: (u) => u.includes('braintree-api.com/graphql') },
  { id: 'authorizenet', secrets: { login_id: 'l', transaction_key: 't' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'nonce' }, isCharge: (u) => u.endsWith('/xml/v1/request.api') },
  { id: 'airwallex', secrets: { client_id: 'c', api_key: 'k' }, payload: { currency: 'USD', paymentMethod: 'card', paymentToken: 'cst_1', metadata: { airwallexCustomerId: 'cus_1' } }, isCharge: (u) => u.endsWith('/confirm'), aux: HOST_CASES.find((c) => c.id === 'airwallex')!.aux },
  { id: 'flutterwave', secrets: { api_key: 'FLWSECK_TEST' }, payload: { currency: 'NGN', paymentMethod: 'card', paymentToken: 'flw-t1nf-x', metadata: { email: 'a@example.com' } }, isCharge: (u) => u.endsWith('/v3/tokenized-charges') },
  { id: 'pawapay', secrets: { api_key: 'k' }, payload: { currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567', metadata: { pawapayProvider: 'AIRTEL_MWI' } }, isCharge: (u) => u.endsWith('/v2/deposits') },
  { id: 'paychangu', secrets: { api_key: 'k' }, payload: { currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567', metadata: { paychanguOperatorRefId: 'op' } }, isCharge: (u) => u.endsWith('/mobile-money/payments/initialize') },
];

describe("Phase 26 — E4 re-verified: the adapter's OWN AbortController timeout really firing (not a thrown stand-in) → 'unknown', never 'failed'", () => {
  for (const c of MONEY_MOVING) {
    it(`${c.id}: charge request hangs until the adapter's internal per-attempt timer aborts it → status 'unknown'`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const registry = ProviderRegistry.createIsolatedInstance();
      const provider = registry.getProvider(c.id)!;
      provider.setSecrets(c.secrets);
      const chargeAborts: string[] = [];

      vi.stubGlobal('fetch', vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const aux = c.aux?.(url);
        if (aux) return Promise.resolve(aux);
        if (!c.isCharge(url)) return Promise.resolve(json({}));
        // Never answers. Rejects exactly the way undici does when the
        // request's own AbortSignal fires — and ONLY then.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            chargeAborts.push(url);
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        });
      }));

      const pending = provider.processRequest('app_p26', { paymentTransactionId: randomUUID(), amount: 25, ...c.payload } as never, 'phase26');
      // Far past every attempt's 30s timeout plus retry backoff.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const event = await pending;

      expect(chargeAborts.length).toBeGreaterThanOrEqual(1); // the internal timer really fired
      expect(event.status).toBe('unknown');
      expect(String(event.decisionReason)).toContain('Ambiguous provider outcome');
    });
  }
});
