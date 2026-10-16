import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { PaymentRequest, ProviderConfig } from '@company/schemas';
import {
  BaseProvider,
  buildIdempotencyIdentity,
  identityToUuid,
  ProviderNotConfiguredError,
  MissingPaymentInputError,
  MissingPaymentTransactionIdError,
  SimulatedFallbackBlockedError,
} from './base';
import { StripeProvider } from './adapters/payments/stripe';
import { CheckoutComProvider } from './adapters/payments/checkout';
import { PaystackProvider } from './adapters/payments/paystack';
import { AdyenProvider } from './adapters/payments/adyen';
import { NMIProvider } from './adapters/payments/nmi';
import { AuthorizeNetProvider } from './adapters/payments/authorizenet';
import { BraintreeProvider } from './adapters/payments/braintree';
import { FlutterwaveProvider } from './adapters/payments/flutterwave';
import { PawaPayProvider } from './adapters/payments/pawapay';
import { PayChanguProvider } from './adapters/payments/paychangu';
import { PayPalProvider } from './adapters/payments/paypal';
import { SquareProvider } from './adapters/payments/square';
import { AirwallexProvider } from './adapters/payments/airwallex';
import { ExamplePaymentProvider } from './adapters/payments/example';

/**
 * Phase 3 — gap register E7/C11 (deterministic provider idempotency identity)
 * and E2 (production kill-switch for simulated fallbacks), proven per
 * adapter against the request each adapter ACTUALLY puts on the wire
 * (global fetch is stubbed and every outbound request captured).
 */

const TX_A = '0f6c2b7e-5a51-4c1e-9f3b-2d8e4a6c1b90';
const TX_B = 'c3d9e8f1-7b22-4a0d-8e65-1f4a9b3c7d02';

function cfg(id: string): ProviderConfig {
  return { id, name: id, category: 'payment', status: 'online', weight: 50, latencyMin: 0, latencyMax: 0 };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function parseBody(raw: unknown): any {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

/** Stubs fetch: auth endpoints get a token, everything else a generic 200 JSON; every request is captured. */
function captureFetch(): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit = {}) => {
    captured.push({ url: String(url), headers: (opts.headers ?? {}) as Record<string, string>, body: parseBody(opts.body) });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/oauth2/token')) return json({ access_token: 'paypal-token', expires_in: 3600 });
    if (String(url).includes('/authentication/login')) return json({ token: 'awx-token', expires_at: '2999-01-01T00:00:00Z' });
    if (String(url).includes('/payment_intents/create')) return json({ id: 'int_1', status: 'REQUIRES_PAYMENT_METHOD' });
    return json({ id: 'prov_1', status: 'succeeded' });
  }));
  return captured;
}

interface AdapterCase {
  name: string;
  make: () => BaseProvider;
  env: Record<string, string>;
  payload: Partial<PaymentRequest>;
  /** The provider-facing idempotency identity value(s) this adapter sent. */
  extract: (reqs: Captured[]) => string[];
  /** Expected shape of the identity for TX_A + client key 'order-42'. */
  expectFor: (txId: string, clientKey: string) => string[];
}

const nonAuth = (reqs: Captured[]) =>
  reqs.filter((r) => !r.url.includes('/oauth2/token') && !r.url.includes('/authentication/login'));

const CASES: AdapterCase[] = [
  {
    name: 'stripe',
    make: () => new StripeProvider(cfg('stripe')),
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    payload: { paymentToken: 'pm_card_visa' },
    extract: (r) => [nonAuth(r)[0].headers['Idempotency-Key']],
    expectFor: (tx, k) => [`bis_${tx}_${k}`],
  },
  {
    name: 'checkout',
    make: () => new CheckoutComProvider(cfg('checkout')),
    env: { CHECKOUT_SECRET_KEY: 'sk_sbox_x' },
    payload: { paymentToken: 'tok_abc' },
    extract: (r) => [nonAuth(r)[0].headers['Cko-Idempotency-Key'], nonAuth(r)[0].body.reference],
    expectFor: (tx, k) => [`bis_${tx}_${k}`, `bis_${tx}_${k}`],
  },
  {
    name: 'paystack',
    make: () => new PaystackProvider(cfg('paystack')),
    env: { PAYSTACK_SECRET_KEY: 'sk_test_x' },
    payload: { currency: 'NGN', metadata: { email: 'donor@example.com' } },
    extract: (r) => [nonAuth(r)[0].body.reference],
    expectFor: (tx, k) => [`bis-${tx}-${k}`],
  },
  {
    name: 'adyen',
    make: () => new AdyenProvider(cfg('adyen')),
    env: { ADYEN_API_KEY: 'ak', ADYEN_MERCHANT_ACCOUNT: 'Merchant' },
    payload: { paymentToken: 'stored_1' },
    extract: (r) => [nonAuth(r)[0].headers['Idempotency-Key'], nonAuth(r)[0].body.reference],
    expectFor: (tx, k) => [`bis_${tx}_${k}`, `bis_${tx}_${k}`],
  },
  {
    name: 'nmi',
    make: () => new NMIProvider(cfg('nmi')),
    env: { NMI_API_KEY: 'sec' },
    payload: { paymentToken: 'nmi_tok' },
    extract: (r) => [nonAuth(r)[0].body.orderid],
    expectFor: (tx, k) => [`bis_${tx}_${k}`],
  },
  {
    name: 'authorizenet',
    make: () => new AuthorizeNetProvider(cfg('authorizenet')),
    env: { AUTHORIZENET_LOGIN_ID: 'login', AUTHORIZENET_TRANSACTION_KEY: 'key' },
    payload: { paymentToken: 'accept_js_nonce' },
    extract: (r) => [
      nonAuth(r)[0].body.createTransactionRequest.refId,
      nonAuth(r)[0].body.createTransactionRequest.transactionRequest.order.invoiceNumber,
    ],
    // 20-char fields: always the digest form.
    expectFor: (tx, k) => [buildIdempotencyIdentity(tx, k, { maxLength: 20 }), buildIdempotencyIdentity(tx, k, { maxLength: 20 })],
  },
  {
    name: 'braintree',
    make: () => new BraintreeProvider(cfg('braintree')),
    env: { BRAINTREE_PUBLIC_KEY: 'pub', BRAINTREE_PRIVATE_KEY: 'priv', BRAINTREE_MERCHANT_ID: 'mid' },
    payload: { paymentToken: 'bt_pm' },
    extract: (r) => [nonAuth(r)[0].body.variables.input.transaction.orderId],
    expectFor: (tx, k) => [`bis_${tx}_${k}`],
  },
  {
    name: 'flutterwave',
    make: () => new FlutterwaveProvider(cfg('flutterwave')),
    env: { FLUTTERWAVE_SECRET_KEY: 'FLWSECK-x' },
    payload: { currency: 'NGN', paymentToken: 'flw-t1', metadata: { email: 'donor@example.com' } },
    extract: (r) => [nonAuth(r)[0].body.tx_ref],
    expectFor: (tx, k) => [`bis_${tx}_${k}`],
  },
  {
    name: 'pawapay',
    make: () => new PawaPayProvider(cfg('pawapay')),
    env: { PAWAPAY_API_KEY: 'pk' },
    payload: { currency: 'ZMW', paymentMethod: 'mobile_money', phoneNumber: '260763456789', metadata: { pawapayProvider: 'MTN_MOMO_ZMB' } },
    extract: (r) => [nonAuth(r)[0].body.depositId],
    expectFor: (tx, k) => [identityToUuid(`bis_${tx}_${k}`)],
  },
  {
    name: 'paychangu',
    make: () => new PayChanguProvider(cfg('paychangu')),
    env: { PAYCHANGU_API_KEY: 'pc' },
    payload: { currency: 'MWK', paymentMethod: 'mobile_money', phoneNumber: '265990000000', metadata: { paychanguOperatorRefId: 'op-1' } },
    extract: (r) => [nonAuth(r)[0].body.charge_id],
    expectFor: (tx, k) => [`bis_${tx}_${k}`],
  },
  {
    name: 'paypal',
    make: () => new PayPalProvider(cfg('paypal')),
    env: { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec' },
    payload: { paymentToken: 'vault_1' },
    extract: (r) => [nonAuth(r)[0].headers['PayPal-Request-Id']],
    expectFor: (tx, k) => [`bis_${tx}_${k}`],
  },
  {
    name: 'square',
    make: () => new SquareProvider(cfg('square')),
    env: { SQUARE_ACCESS_TOKEN: 'sq' },
    payload: { paymentToken: 'cnon_1' },
    extract: (r) => [nonAuth(r)[0].body.idempotency_key],
    // 45-char cap: compact form, still a pure function of (txid, key).
    expectFor: (tx, k) => [buildIdempotencyIdentity(tx, k, { maxLength: 45 })],
  },
  {
    name: 'airwallex',
    make: () => new AirwallexProvider(cfg('airwallex')),
    env: { AIRWALLEX_CLIENT_ID: 'cid', AIRWALLEX_API_KEY: 'key' },
    payload: { paymentToken: 'cst_consent', metadata: { airwallexCustomerId: 'cus_1' } },
    extract: (r) => [nonAuth(r)[0].body.request_id, nonAuth(r)[0].body.merchant_order_id, nonAuth(r)[1].body.request_id],
    expectFor: (tx, k) => [
      `bis_${tx}_${k}`,
      `bis_${tx}_${k}`,
      buildIdempotencyIdentity(tx, k, { maxLength: 64, suffix: 'confirm' }),
    ],
  },
];

const ALL_ENV_KEYS = Array.from(new Set(CASES.flatMap((c) => Object.keys(c.env))));
const savedEnv: Record<string, string | undefined> = {};
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  for (const k of ALL_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ALL_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  process.env.NODE_ENV = savedNodeEnv;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function payloadFor(c: AdapterCase, txId: string | undefined, clientKey?: string): PaymentRequest {
  return {
    amount: 25,
    currency: 'USD',
    paymentMethod: 'card',
    ...c.payload,
    ...(txId ? { paymentTransactionId: txId } : {}),
    ...(clientKey ? { idempotencyKey: clientKey } : {}),
  } as PaymentRequest;
}

async function sendOnce(c: AdapterCase, txId: string | undefined, clientKey?: string): Promise<string[]> {
  for (const [k, v] of Object.entries(c.env)) process.env[k] = v;
  const captured = captureFetch();
  await c.make().processRequest('app1', payloadFor(c, txId, clientKey), 'test');
  vi.unstubAllGlobals();
  return c.extract(captured);
}

describe('buildIdempotencyIdentity — pure function of (payment_transaction_id, client key)', () => {
  it('has the spec format bis_<payment_transaction_id>_<idempotency_identity>', () => {
    expect(buildIdempotencyIdentity(TX_A, 'order-42')).toBe(`bis_${TX_A}_order-42`);
    expect(buildIdempotencyIdentity(TX_A, undefined)).toBe(`bis_${TX_A}_default`);
  });

  it('is identical across time and randomness (no Date.now / Math.random / randomUUID input)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = buildIdempotencyIdentity(TX_A, 'k1', { maxLength: 45 });
    vi.setSystemTime(new Date('2031-06-15T12:34:56Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456);
    expect(buildIdempotencyIdentity(TX_A, 'k1', { maxLength: 45 })).toBe(first);
  });

  it('different payment transactions never share an identity, even with the same client key', () => {
    expect(buildIdempotencyIdentity(TX_A, 'same')).not.toBe(buildIdempotencyIdentity(TX_B, 'same'));
    expect(buildIdempotencyIdentity(TX_A, 'same', { maxLength: 45 })).not.toBe(buildIdempotencyIdentity(TX_B, 'same', { maxLength: 45 }));
    expect(buildIdempotencyIdentity(TX_A, 'same', { maxLength: 20 })).not.toBe(buildIdempotencyIdentity(TX_B, 'same', { maxLength: 20 }));
  });

  it('respects provider length/charset limits deterministically', () => {
    const longKey = 'x'.repeat(300);
    const id64 = buildIdempotencyIdentity(TX_A, longKey, { maxLength: 64 });
    expect(id64.length).toBeLessThanOrEqual(64);
    expect(id64.startsWith(`bis_${TX_A.replace(/-/g, '')}_h`)).toBe(true);
    expect(buildIdempotencyIdentity(TX_A, longKey, { maxLength: 64 })).toBe(id64);

    const sq = buildIdempotencyIdentity(TX_A, 'order-42', { maxLength: 45 });
    expect(sq.length).toBeLessThanOrEqual(45);

    const anet = buildIdempotencyIdentity(TX_A, 'order-42', { maxLength: 20 });
    expect(anet).toMatch(/^bis_[0-9a-f]{16}$/);

    const weird = buildIdempotencyIdentity(TX_A, 'has spaces/and:colons');
    expect(weird).toMatch(new RegExp(`^bis_${TX_A}_h[0-9a-f]{32}$`));

    const paystack = buildIdempotencyIdentity(TX_A, 'under_score', { separator: '-', allowedChars: /^[A-Za-z0-9.=-]+$/ });
    expect(paystack).toMatch(/^[A-Za-z0-9.=-]+$/);
  });

  it('refuses to build an identity without a payment transaction id', () => {
    expect(() => buildIdempotencyIdentity(undefined, 'k')).toThrow(MissingPaymentTransactionIdError);
    expect(() => buildIdempotencyIdentity('', 'k')).toThrow(MissingPaymentTransactionIdError);
  });

  it('identityToUuid is a deterministic, v4-shaped UUID', () => {
    const u = identityToUuid(`bis_${TX_A}_k`);
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identityToUuid(`bis_${TX_A}_k`)).toBe(u);
    expect(identityToUuid(`bis_${TX_B}_k`)).not.toBe(u);
  });
});

describe('every real payment adapter sends a deterministic identity on the wire (E7)', () => {
  for (const c of CASES) {
    it(`${c.name}: same payment → same identity across time; different payment → different identity; format bis_<txid>_<key>`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-01T10:00:00Z'));
      const a1 = await sendOnce(c, TX_A, 'order-42');
      vi.setSystemTime(new Date('2026-03-01T10:07:31Z')); // well past any minute/second bucket
      const a2 = await sendOnce(c, TX_A, 'order-42');
      const b = await sendOnce(c, TX_B, 'order-42');
      const aNoKey = await sendOnce(c, TX_A, undefined);

      expect(a1.every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
      expect(a2).toEqual(a1); // retry of the same payment: identical
      expect(a1).toEqual(c.expectFor(TX_A, 'order-42')); // exact, predictable value
      for (let i = 0; i < a1.length; i++) expect(b[i]).not.toBe(a1[i]); // different payment
      expect(aNoKey).toEqual(c.expectFor(TX_A, 'default'));
    });
  }

  it('a real call is refused (no HTTP request) when the payload has no paymentTransactionId', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const captured = captureFetch();
    await expect(
      new StripeProvider(cfg('stripe')).processRequest('app1', { amount: 5, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_1' }, 't'),
    ).rejects.toThrow(MissingPaymentTransactionIdError);
    expect(captured).toHaveLength(0);
  });

  it('no adapter source still builds a payment idempotency identity from Date.now()/random values', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(__dirname, 'adapters', 'payments');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      // The banned historical patterns, verbatim shapes.
      if (/bis_\$\{appId\}_\$\{Date\.now\(\)\}/.test(src)) offenders.push(`${f}: bis_\${appId}_\${Date.now()}`);
      if (/Math\.floor\(Date\.now\(\)\s*\/\s*(60_000|1000)\)/.test(src)) offenders.push(`${f}: time-bucketed key`);
      if (/refId:\s*`bis_\$\{Date\.now\(\)\}`/.test(src)) offenders.push(`${f}: refId Date.now()`);
      if (/idempotencyKey\s*\|\|\s*randomUUID\(\)/.test(src)) offenders.push(`${f}: key || randomUUID()`);
      if (/request_id:\s*randomUUID\(\)/.test(src)) offenders.push(`${f}: request_id randomUUID()`);
      if (/\(payload as any\)\.idempotencyKey/.test(src)) offenders.push(`${f}: (payload as any).idempotencyKey`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('production kill-switch for simulated fallbacks (E2)', () => {
  for (const c of CASES) {
    it(`${c.name}: unconfigured → throws ProviderNotConfiguredError in production (no HTTP), simulates in test`, async () => {
      const captured = captureFetch();
      process.env.NODE_ENV = 'production';
      const err = await c.make().processRequest('app1', payloadFor(c, TX_A, 'k'), 't').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderNotConfiguredError);
      expect(err).toBeInstanceOf(SimulatedFallbackBlockedError);
      expect((err as ProviderNotConfiguredError).code).toBe('provider_not_configured');
      expect(captured).toHaveLength(0);

      process.env.NODE_ENV = 'test';
      const simulated = await c.make().processRequest('app1', payloadFor(c, TX_A, 'k'), 't');
      expect(simulated.status).toBe('success'); // unchanged dev/test behaviour
      expect(captured).toHaveLength(0);
    });
  }

  for (const c of CASES.filter((x) => x.payload.paymentToken)) {
    it(`${c.name}: configured but no paymentToken → MissingPaymentInputError in production (no fabricated success)`, async () => {
      for (const [k, v] of Object.entries(c.env)) process.env[k] = v;
      const captured = captureFetch();
      process.env.NODE_ENV = 'production';
      const p = payloadFor(c, TX_A, 'k');
      delete p.paymentToken;
      const err = await c.make().processRequest('app1', p, 't').then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(MissingPaymentInputError);
      expect((err as MissingPaymentInputError).missing).toContain('paymentToken');
      expect(captured).toHaveLength(0);
    });
  }

  it('the simulation-only example adapter refuses in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(
      new ExamplePaymentProvider(cfg('example-pay')).processRequest('app1', { amount: 1, currency: 'USD', paymentMethod: 'card' }, 't'),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });

  it('the default (fabricated) refund refuses in production, still simulates in test', async () => {
    const checkout = new CheckoutComProvider(cfg('checkout'));
    process.env.NODE_ENV = 'production';
    await expect(checkout.refund('app1', { originalTransactionId: 'pay_1', amount: 1 }, 't')).rejects.toThrow(ProviderNotConfiguredError);
    process.env.NODE_ENV = 'test';
    expect((await checkout.refund('app1', { originalTransactionId: 'pay_1', amount: 1 }, 't')).status).toBe('success');
  });

  it('isConfigured() now reflects real credentials for AuthorizeNet, Checkout.com and Paystack (was always true)', () => {
    const anet = new AuthorizeNetProvider(cfg('authorizenet'));
    const cko = new CheckoutComProvider(cfg('checkout'));
    const ps = new PaystackProvider(cfg('paystack'));
    expect([anet.isConfigured(), cko.isConfigured(), ps.isConfigured()]).toEqual([false, false, false]);
    process.env.AUTHORIZENET_LOGIN_ID = 'l';
    expect(anet.isConfigured()).toBe(false); // needs both
    process.env.AUTHORIZENET_TRANSACTION_KEY = 'k';
    process.env.CHECKOUT_SECRET_KEY = 's';
    process.env.PAYSTACK_SECRET_KEY = 's';
    expect([anet.isConfigured(), cko.isConfigured(), ps.isConfigured()]).toEqual([true, true, true]);
  });
});
