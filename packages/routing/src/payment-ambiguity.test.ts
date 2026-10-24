/**
 * Phase 11-12 — gap register A10 / E4 / PHASE3-01 / E5: the cross-provider
 * double-charge path.
 *
 * Every test here drives the REAL RoutingEngine.routePayment() through the
 * REAL ProviderRegistry and the REAL payment adapters (configured with fake
 * credentials via setSecrets), with only the global `fetch` stubbed — so what
 * is proven is the full adapter-classification → router-decision chain, not a
 * mocked processRequest().
 *
 * For each of the 12 adapters that make a real money-moving HTTP call:
 *  - an AMBIGUOUS outcome (HTTP 5xx, a mid-flight network error
 *    (ECONNRESET), the adapter's own internal AbortError timeout) is
 *    classified 'unknown' — never 'failed' — and the router does NOT call
 *    any other provider's processRequest();
 *  - a GENUINE, unambiguous decline in that provider's own documented
 *    response shape is still 'failed' AND is still failed over to another
 *    provider (the legitimate retry case is preserved).
 *
 * The decline shapes below are written from each provider's public API
 * documentation as known to the implementing agent — NOT verified against a
 * live sandbox from this environment (no credentials / no network path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RoutingEngine } from './index';
import { ProviderRegistry } from '@company/providers';
import type { PaymentRoutingRequest } from '@company/schemas';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

/** What undici's fetch rejects with when a socket dies mid-request. */
const resetError = () =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
/** What fetch rejects with when the adapter's own per-attempt AbortController fires. */
const abortError = () => new DOMException('This operation was aborted', 'AbortError');
/** A connect-phase failure: provably nothing was sent. */
const refusedError = () =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }) });

interface AdapterCase {
  id: string;
  secrets: Record<string, string>;
  request: Partial<PaymentRoutingRequest>;
  /** The money-moving request (everything else is an auxiliary auth/create call). */
  isCharge(url: string): boolean;
  aux?(url: string): Response | undefined;
  /** A genuine decline in this provider's documented response shape. */
  decline(): Response;
  /** Provider genuinely dedupes on its idempotency key → internal retry of an ambiguous attempt allowed. */
  idempotentRetry: boolean;
  setup?(): () => void;
}

const CASES: AdapterCase[] = [
  {
    id: 'stripe',
    secrets: { api_key: 'sk_test_x' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_card_visa' },
    isCharge: (u) => u === 'https://api.stripe.com/v1/payment_intents',
    // Stripe: HTTP 402, error.type 'card_error' with a decline_code.
    decline: () => json({ error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } }, 402),
    idempotentRetry: true,
  },
  {
    id: 'adyen',
    // Phase 26 (E11): Adyen is registered 'live', and the registered
    // environment now really reaches the adapter — so it needs its live URL
    // prefix (without one it refuses to call any host, instead of silently
    // calling checkout-test.adyen.com as it used to).
    secrets: { api_key: 'AQE_x', merchant_account: 'MerchantECOM', live_url_prefix: 'bisapitest' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'stored_pm_1' },
    isCharge: (u) => u.endsWith('/v71/payments'),
    // Adyen: HTTP 200 with resultCode 'Refused' and a refusalReason.
    decline: () => json({ pspReference: 'PSP1', resultCode: 'Refused', refusalReason: 'Not enough balance', refusalReasonCode: '51' }),
    idempotentRetry: true,
  },
  {
    id: 'nmi',
    secrets: { api_key: 'nmi_key' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'collectjs_tok' },
    isCharge: (u) => u.endsWith('/api/transact.php'),
    // NMI: HTTP 200, form-encoded response=2 (declined), response_code 202 (insufficient funds).
    decline: () => text('response=2&responsetext=DECLINE&authcode=&transactionid=9001&response_code=202'),
    idempotentRetry: false,
  },
  {
    id: 'paypal',
    secrets: { client_id: 'cid', client_secret: 'csec' },
    request: { currency: 'USD', paymentMethod: 'wallet', paymentToken: 'vault_1' },
    isCharge: (u) => u.endsWith('/v2/checkout/orders'),
    aux: (u) => (u.endsWith('/v1/oauth2/token') ? json({ access_token: 'A21', expires_in: 32400 }) : undefined),
    // PayPal: HTTP 422 UNPROCESSABLE_ENTITY, details[].issue INSTRUMENT_DECLINED.
    decline: () =>
      json(
        {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
          details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was either declined by the processor or bank, or it can\'t be used for this payment.' }],
        },
        422,
      ),
    idempotentRetry: true,
    // PayPal is the only 'wallet' provider seeded; give the (test-env,
    // simulated) example adapter the capability too so a decline has
    // somewhere legitimate to fail over to.
    setup: () => {
      const registry = ProviderRegistry.getInstance();
      const before = registry.getManagementView('example-pay')!.capabilities;
      registry.updateManagement('example-pay', { capabilities: [...before, 'wallet'] });
      return () => registry.updateManagement('example-pay', { capabilities: before });
    },
  },
  {
    id: 'square',
    secrets: { access_token: 'sq_tok' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'cnon:card-nonce-ok' },
    isCharge: (u) => u.endsWith('/v2/payments'),
    // Square: HTTP 402, errors[].category PAYMENT_METHOD_ERROR.
    decline: () =>
      json({ errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: 'Authorization error: \'GENERIC_DECLINE\'' }], payment: { id: 'sq_p1', status: 'FAILED' } }, 402),
    idempotentRetry: true,
  },
  {
    id: 'checkout',
    secrets: { api_key: 'sk_sbox_x' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_x' },
    isCharge: (u) => u === 'https://api.checkout.com/payments',
    // Checkout.com: HTTP 201, approved:false, status 'Declined', response_code 20051.
    decline: () => json({ id: 'pay_1', approved: false, status: 'Declined', response_code: '20051', response_summary: 'Insufficient Funds' }, 201),
    idempotentRetry: true,
  },
  {
    id: 'braintree',
    secrets: { public_key: 'pub', private_key: 'priv', merchant_id: 'mid' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'fake-valid-nonce' },
    isCharge: (u) => u.includes('braintree-api.com/graphql'),
    // Braintree GraphQL: 200 with a PROCESSOR_DECLINED transaction.
    decline: () => json({ data: { chargeCreditCard: { transaction: { id: 'bt_1', status: 'PROCESSOR_DECLINED' } } } }),
    idempotentRetry: false,
  },
  {
    id: 'authorizenet',
    secrets: { login_id: 'login', transaction_key: 'txkey' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'accept_js_nonce' },
    isCharge: (u) => u.endsWith('/xml/v1/request.api'),
    // Authorize.Net: 200, transactionResponse.responseCode '2' (declined).
    decline: () =>
      json({
        transactionResponse: { responseCode: '2', transId: '0', errors: [{ errorCode: '2', errorText: 'This transaction has been declined.' }] },
        messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'The transaction was unsuccessful.' }] },
      }),
    idempotentRetry: false,
  },
  {
    id: 'airwallex',
    secrets: { client_id: 'awx_c', api_key: 'awx_k' },
    request: { currency: 'USD', paymentMethod: 'card', paymentToken: 'cst_consent_1', metadata: { airwallexCustomerId: 'cus_1' } },
    isCharge: (u) => u.endsWith('/confirm'),
    aux: (u) =>
      u.endsWith('/authentication/login')
        ? json({ token: 'awx_token', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() })
        : u.endsWith('/payment_intents/create')
          ? json({ id: 'int_awx_1', status: 'REQUIRES_PAYMENT_METHOD' })
          : undefined,
    // Airwallex: confirm returns the intent still in REQUIRES_PAYMENT_METHOD (declined).
    decline: () => json({ id: 'int_awx_1', status: 'REQUIRES_PAYMENT_METHOD', message: 'Card declined' }),
    idempotentRetry: false,
  },
  {
    id: 'flutterwave',
    secrets: { api_key: 'FLWSECK_TEST' },
    request: { currency: 'NGN', paymentMethod: 'card', paymentToken: 'flw-t1nf-x', metadata: { email: 'a@example.com' } },
    isCharge: (u) => u.endsWith('/v3/tokenized-charges'),
    // Flutterwave: 200, top-level success, data.status 'failed'.
    decline: () => json({ status: 'success', message: 'Charge attempted', data: { id: 777, status: 'failed', processor_response: 'Insufficient Funds' } }),
    idempotentRetry: false,
  },
  {
    id: 'pawapay',
    secrets: { api_key: 'pawa_key' },
    request: { currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567', metadata: { pawapayProvider: 'AIRTEL_MWI' } },
    isCharge: (u) => u.endsWith('/v2/deposits'),
    // PawaPay v2: 200 with status REJECTED and a failureReason.
    decline: () => json({ depositId: 'x', status: 'REJECTED', failureReason: { failureCode: 'PAYER_NOT_FOUND', failureMessage: 'The phone number is not registered for mobile money' } }),
    idempotentRetry: true,
  },
  {
    id: 'paychangu',
    secrets: { api_key: 'pc_key' },
    request: { currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265991234567', metadata: { paychanguOperatorRefId: 'op_airtel' } },
    isCharge: (u) => u.endsWith('/mobile-money/payments/initialize'),
    // PayChangu: 200, top-level success, data.status 'failed'.
    decline: () => json({ status: 'success', message: 'Payment failed', data: { status: 'failed', message: 'Insufficient balance' } }),
    idempotentRetry: false,
  },
];

type ChargeBehaviour = () => Response | Promise<Response>;

/**
 * Phase 15 (gap register A14d): the router now records EVERY provider
 * attempt against the provider's circuit breaker (it used to record
 * nothing — only the gateway's observe() of the final event did). The
 * cases below deliberately drive many ambiguous/failed outcomes into the
 * same shared registry, which would trip a provider's breaker and make a
 * later, unrelated case fall back elsewhere. Each case asserts outcome
 * classification on a healthy provider, so each starts from a closed
 * circuit (the same reset routing.test.ts applies after every test).
 */
function resetCircuits(registry: ProviderRegistry): void {
  for (const cfg of registry.getAllConfigs()) registry.updateProviderConfig(cfg.id, { status: 'online' });
}

describe('Phase 11-12 — ambiguous payment outcomes are never failed over; genuine declines still are (A10/E4)', () => {
  const registry = ProviderRegistry.getInstance();
  const engine = new RoutingEngine();
  let chargeCalls: Array<{ provider: string; url: string; at: number }> = [];
  const restorers: Array<() => void> = [];

  function install(c: AdapterCase, onCharge: ChargeBehaviour) {
    registry.getProvider(c.id)!.setSecrets(c.secrets);
    restorers.push(() => registry.getProvider(c.id)!.setSecrets({}));
    if (c.setup) restorers.push(c.setup());
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      const aux = c.aux?.(url);
      if (aux) return aux;
      if (c.isCharge(url)) {
        chargeCalls.push({ provider: c.id, url, at: Date.now() });
        return onCharge();
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }));
  }

  /** Spies (call-through) on every OTHER payment adapter's processRequest. */
  function spyOthers(exceptId: string) {
    const spies = registry
      .getAllConfigs()
      .filter((p) => p.category === 'payment' && p.id !== exceptId)
      .map((p) => ({ id: p.id, spy: vi.spyOn(registry.getProvider(p.id)!, 'processRequest') }));
    return { calledIds: () => spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.id) };
  }

  function route(c: AdapterCase) {
    const paymentTransactionId = randomUUID();
    return {
      paymentTransactionId,
      promise: engine.routePayment('app_p11', {
        amount: 25,
        ...c.request,
        providerOverride: c.id,
        idempotencyKey: `order-${paymentTransactionId.slice(0, 8)}`,
        paymentTransactionId,
      } as PaymentRoutingRequest),
    };
  }

  beforeEach(() => {
    chargeCalls = [];
    resetCircuits(registry);
  });

  afterEach(() => {
    while (restorers.length) restorers.pop()!();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const c of CASES) {
    describe(c.id, () => {
      const ambiguous: Array<[string, ChargeBehaviour]> = [
        ['HTTP 503 from the provider', () => json({ error: { message: 'Service Unavailable' }, message: 'Service Unavailable' }, 503)],
        ['a mid-request network error (ECONNRESET)', () => { throw resetError(); }],
        ["the adapter's own internal AbortError timeout", () => { throw abortError(); }],
      ];

      for (const [label, behaviour] of ambiguous) {
        it(`${label} → 'unknown', and NO other provider's processRequest is ever called`, async () => {
          install(c, behaviour);
          const others = spyOthers(c.id);
          const { promise } = route(c);
          const event = await promise;

          expect(event.status).toBe('unknown');
          expect(event.providerId).toBe(c.id);
          expect(String(event.decisionReason)).not.toContain('Dynamic Failover');
          expect(others.calledIds()).toEqual([]);
          // Non-idempotent providers: the possibly-processed charge was sent
          // exactly once (no blind internal re-send either).
          if (!c.idempotentRetry) expect(chargeCalls).toHaveLength(1);
          expect(chargeCalls.length).toBeGreaterThanOrEqual(1);
        }, 15_000);
      }

      it(`a genuine decline (${c.id}'s documented decline shape) → 'failed', and IS failed over to another provider`, async () => {
        install(c, c.decline);
        const others = spyOthers(c.id);
        const { promise } = route(c);
        const event = await promise;

        expect(chargeCalls).toHaveLength(1);
        expect(others.calledIds().length).toBeGreaterThanOrEqual(1);
        expect(event.providerId).not.toBe(c.id);
        expect(event.status).toBe('success'); // a simulated (unconfigured) fallback provider
        expect(String(event.decisionReason)).toContain(`Dynamic Failover`);
        expect(String(event.decisionReason)).toContain('declined');
      }, 15_000);
    });
  }

  it('the adapter-level decline itself is reported as failed (not unknown) — checked directly, before any routing', async () => {
    for (const c of CASES) {
      install(c, c.decline);
      const provider = registry.getProvider(c.id)!;
      const event = await provider.processRequest(
        'app_p11',
        { amount: 25, ...c.request, paymentTransactionId: randomUUID() } as never,
        'direct',
      );
      expect({ id: c.id, status: event.status }).toEqual({ id: c.id, status: 'failed' });
      while (restorers.length) restorers.pop()!();
      vi.unstubAllGlobals();
    }
  });

  describe('precision: only genuine ambiguity becomes unknown', () => {
    it('a connect-phase failure (ECONNREFUSED — provably never sent) is a definite failure and IS failed over', async () => {
      const stripe = CASES.find((c) => c.id === 'stripe')!;
      install(stripe, () => { throw refusedError(); });
      const others = spyOthers('stripe');
      const event = await route(stripe).promise;
      expect(others.calledIds().length).toBeGreaterThanOrEqual(1);
      expect(event.providerId).not.toBe('stripe');
      expect(String(event.decisionReason)).toContain('ECONNREFUSED');
    }, 15_000);

    it('a 4xx validation rejection (Stripe invalid_request_error 400) is definite → failed over', async () => {
      const stripe = CASES.find((c) => c.id === 'stripe')!;
      install(stripe, () => json({ error: { type: 'invalid_request_error', message: 'No such PaymentMethod: pm_x' } }, 400));
      const others = spyOthers('stripe');
      const event = await route(stripe).promise;
      expect(others.calledIds().length).toBeGreaterThanOrEqual(1);
      expect(event.providerId).not.toBe('stripe');
    });

    it('Stripe 409 (idempotency key in use by a request still executing) is ambiguous → unknown, not failed over', async () => {
      const stripe = CASES.find((c) => c.id === 'stripe')!;
      install(stripe, () => json({ error: { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'There is currently another in-progress request using this Stripe API key' } }, 409));
      const others = spyOthers('stripe');
      const event = await route(stripe).promise;
      expect(event.status).toBe('unknown');
      expect(others.calledIds()).toEqual([]);
    });

    it("a duplicate rejection on a retry AFTER an ambiguous attempt is ambiguous (it may be rejecting a duplicate of a processed charge)", async () => {
      // Square retries a 5xx (it dedupes on idempotency_key). If the retry is
      // answered with a 4xx, that 4xx may be about the first, processed
      // attempt — so the outcome stays unknown.
      const square = CASES.find((c) => c.id === 'square')!;
      let n = 0;
      install(square, () => (++n === 1 ? json({ errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR' }] }, 500) : json({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'conflict' }] }, 400)));
      const others = spyOthers('square');
      const event = await route(square).promise;
      expect(chargeCalls).toHaveLength(2);
      expect(event.status).toBe('unknown');
      expect(others.calledIds()).toEqual([]);
    }, 15_000);

    it('NMI "Duplicate transaction" (response=3) and Authorize.Net error 11 / held-for-review are ambiguous', async () => {
      const nmi = CASES.find((c) => c.id === 'nmi')!;
      install(nmi, () => text('response=3&responsetext=Duplicate transaction REFID:3157483&response_code=300'));
      expect((await route(nmi).promise).status).toBe('unknown');
      while (restorers.length) restorers.pop()!();

      const anet = CASES.find((c) => c.id === 'authorizenet')!;
      install(anet, () =>
        json({
          transactionResponse: { responseCode: '3', errors: [{ errorCode: '11', errorText: 'A duplicate transaction has been submitted.' }] },
          messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'The transaction was unsuccessful.' }] },
        }),
      );
      expect((await route(anet).promise).status).toBe('unknown');
      while (restorers.length) restorers.pop()!();

      install(anet, () =>
        json({
          transactionResponse: { responseCode: '4', transId: '6001', errors: [{ errorCode: '252', errorText: 'Your order has been received. Thank you for your business!' }] },
          messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] },
        }),
      );
      expect((await route(anet).promise).status).toBe('unknown');
    });

    it('Checkout.com 202 Pending (async/3DS) is unknown, not failed (it used to be failed and failed over)', async () => {
      const checkout = CASES.find((c) => c.id === 'checkout')!;
      install(checkout, () => json({ id: 'pay_pending', status: 'Pending', _links: { redirect: { href: 'https://3ds' } } }, 202));
      const others = spyOthers('checkout');
      const event = await route(checkout).promise;
      expect(event.status).toBe('unknown');
      expect(others.calledIds()).toEqual([]);
    });

    it('Airwallex: a failure before /confirm is a definite non-charge (failed over); an ambiguous /confirm keeps the intent id for reconciliation', async () => {
      const awx = CASES.find((c) => c.id === 'airwallex')!;
      // create-intent 503: confirm never sent → nothing could be charged.
      registry.getProvider('airwallex')!.setSecrets(awx.secrets);
      restorers.push(() => registry.getProvider('airwallex')!.setSecrets({}));
      const confirmCalls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/authentication/login')) return json({ token: 't', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() });
        if (url.endsWith('/payment_intents/create')) return json({ message: 'unavailable' }, 503);
        confirmCalls.push(url);
        return json({});
      }));
      const others = spyOthers('airwallex');
      const first = await route(awx).promise;
      expect(confirmCalls).toEqual([]);
      expect(others.calledIds().length).toBeGreaterThanOrEqual(1);
      expect(first.providerId).not.toBe('airwallex');
      vi.restoreAllMocks();

      install(awx, () => { throw resetError(); });
      const others2 = spyOthers('airwallex');
      const second = await route(awx).promise;
      expect(second.status).toBe('unknown');
      expect(second.id).toBe('int_awx_1');
      expect(others2.calledIds()).toEqual([]);
    }, 15_000);

    it('Paystack initialize (hosted checkout — moves no money) stays a definite failure even on a 5xx', async () => {
      registry.getProvider('paystack')!.setSecrets({ api_key: 'sk_test_ps' });
      restorers.push(() => registry.getProvider('paystack')!.setSecrets({}));
      vi.stubGlobal('fetch', vi.fn(async () => json({ status: false, message: 'Internal error' }, 500)));
      const event = await registry.getProvider('paystack')!.processRequest(
        'app_p11',
        { amount: 25, currency: 'NGN', paymentMethod: 'card', metadata: { email: 'a@example.com' }, paymentTransactionId: randomUUID() } as never,
        'direct',
      );
      expect(event.status).toBe('failed');
    }, 15_000);

    it('an UNCLASSIFIED error thrown out of processRequest is treated as ambiguous by the router (fail safe)', async () => {
      const others = spyOthers('stripe');
      vi.spyOn(registry.getProvider('stripe')!, 'processRequest').mockRejectedValueOnce(new Error('socket hang up'));
      const event = await engine.routePayment('app_p11', {
        amount: 25, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', paymentTransactionId: randomUUID(),
      });
      expect(event.status).toBe('unknown');
      expect(others.calledIds()).toEqual([]);
    });
  });
});

describe('Phase 11-12 — Stripe Radar highest-risk block reverses the Stripe-side charge (E5)', () => {
  const registry = ProviderRegistry.getInstance();
  const engine = new RoutingEngine();
  const calls: Array<{ url: string; body: string; idem?: string; at: number }> = [];

  const riskyIntent = (status: 'succeeded' | 'requires_capture') =>
    json({
      id: 'pi_risky',
      object: 'payment_intent',
      status,
      latest_charge: { id: 'ch_risky', outcome: { risk_level: 'highest', risk_score: 93, type: 'authorized', seller_message: 'Stripe blocked this payment as too risky.' } },
    });

  function stubStripe(handlers: { reversal: () => Response | Promise<Response>; intentStatus: 'succeeded' | 'requires_capture' }) {
    registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_radar' });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, body: String(init?.body ?? ''), idem: headers['Idempotency-Key'], at: Date.now() });
      if (url === 'https://api.stripe.com/v1/payment_intents') return riskyIntent(handlers.intentStatus);
      return handlers.reversal();
    }));
  }

  beforeEach(() => {
    calls.length = 0;
    resetCircuits(registry);
  });
  afterEach(() => {
    registry.getProvider('stripe')!.setSecrets({});
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a captured ('succeeded') Radar-highest charge is REFUNDED at Stripe before 'failed' is reported — and only then failed over", async () => {
    stubStripe({ intentStatus: 'succeeded', reversal: () => json({ id: 're_1', object: 'refund', status: 'succeeded', payment_intent: 'pi_risky' }) });
    const fallbackCalledAt: number[] = [];
    for (const p of registry.getAllConfigs().filter((c) => c.category === 'payment' && c.id !== 'stripe')) {
      const provider = registry.getProvider(p.id)!;
      const original = provider.processRequest.bind(provider);
      vi.spyOn(provider, 'processRequest').mockImplementation(async (...a: any[]) => {
        fallbackCalledAt.push(Date.now());
        return original(...(a as [any, any, any]));
      });
    }

    const event = await engine.routePayment('app_p11', {
      amount: 40, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', paymentToken: 'pm_x', paymentTransactionId: randomUUID(),
    });

    // Both happened: a real refund call for the captured PaymentIntent...
    const refund = calls.find((c) => c.url === 'https://api.stripe.com/v1/refunds');
    expect(refund).toBeDefined();
    expect(refund!.body).toContain('payment_intent=pi_risky');
    expect(refund!.idem).toMatch(/^bis_.+_radar_refund$/);
    // ...and the stripe attempt was reported failed (visible in the cascade reason).
    expect(String(event.decisionReason)).toContain("'Stripe' declined (Blocked by Stripe Radar");
    expect(String(event.decisionReason)).toContain('captured charge was refunded');
    // The failover to another provider happened only AFTER the refund call.
    expect(fallbackCalledAt.length).toBe(1);
    expect(fallbackCalledAt[0]).toBeGreaterThanOrEqual(refund!.at);
    expect(event.providerId).not.toBe('stripe');
  });

  it("an authorized-only ('requires_capture') Radar-highest charge is CANCELLED (not refunded) at Stripe, then reported failed", async () => {
    stubStripe({ intentStatus: 'requires_capture', reversal: () => json({ id: 'pi_risky', object: 'payment_intent', status: 'canceled', cancellation_reason: 'fraudulent' }) });
    const event = await registry.getProvider('stripe')!.processRequest(
      'app_p11',
      { amount: 40, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_x', paymentTransactionId: randomUUID() } as never,
      'direct',
    );
    expect(event.status).toBe('failed');
    expect(event.error).toContain('authorization was cancelled');
    const cancel = calls.find((c) => c.url === 'https://api.stripe.com/v1/payment_intents/pi_risky/cancel');
    expect(cancel).toBeDefined();
    expect(cancel!.body).toContain('cancellation_reason=fraudulent');
    expect(calls.some((c) => c.url.endsWith('/v1/refunds'))).toBe(false);
  });

  it("when the reversal cannot be confirmed, the outcome is 'unknown' (charge may still be captured) — and the router charges NO other provider", async () => {
    stubStripe({ intentStatus: 'succeeded', reversal: () => json({ error: { type: 'api_error', message: 'An unknown error occurred' } }, 500) });
    const otherIds = registry.getAllConfigs().filter((c) => c.category === 'payment' && c.id !== 'stripe').map((c) => c.id);
    const spies = otherIds.map((id) => vi.spyOn(registry.getProvider(id)!, 'processRequest'));

    const event = await engine.routePayment('app_p11', {
      amount: 40, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', paymentToken: 'pm_x', paymentTransactionId: randomUUID(),
    });

    expect(calls.filter((c) => c.url.endsWith('/v1/refunds')).length).toBeGreaterThanOrEqual(1);
    expect(event.status).toBe('unknown');
    expect(event.providerId).toBe('stripe');
    expect(event.error).toContain('could NOT be confirmed');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  }, 15_000);
});
