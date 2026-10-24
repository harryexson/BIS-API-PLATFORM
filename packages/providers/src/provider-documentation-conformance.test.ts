import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ProviderConfig } from '@company/schemas';
import { ProviderNotConfiguredError } from './index';
import { CheckoutComProvider } from './adapters/payments/checkout';
import { PawaPayProvider, formatPawaPayAmount } from './adapters/payments/pawapay';
import { StripeProvider } from './adapters/payments/stripe';
import { AfricasTalkingProvider } from './adapters/messaging/africastalking';
import { TwilioProvider } from './adapters/messaging/twilio';

/**
 * Phase 27 — provider documentation conformance (8-provider audit).
 *
 * Live sandbox certification is BLOCKED (no provider sandbox credentials in
 * this environment). Each case below pins a request-contract defect that was
 * found by checking an adapter against the provider's CURRENT public
 * documentation / official SDK source, not against a live API. The cited
 * source is named on each describe block.
 *
 * House style (adapter-contract-conformance.test.ts): `fetch` is stubbed and
 * the request the adapter actually sent is captured and asserted on — never
 * just the returned status. No test here contacts a real provider.
 */

type Captured = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function captureFetch(respond: (url: string) => Response = () => json({})) {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: String(init?.method ?? 'GET'),
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return respond(url);
    }),
  );
  return calls;
}

function cfg(id: string, category: 'payment' | 'messaging', environment?: 'live' | 'test'): ProviderConfig {
  return {
    id,
    name: id,
    category,
    status: 'online',
    weight: 50,
    latencyMin: 1,
    latencyMax: 2,
    ...(environment ? { environment } : {}),
  } as ProviderConfig;
}

const PTX = '5b0c8a2e-3f4d-4c1a-9e6b-7a8d9c0e1f23';
const ENV_KEYS = [
  'NODE_ENV',
  'CHECKOUT_SECRET_KEY',
  'CHECKOUT_API_PREFIX',
  'PAWAPAY_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'AFRICASTALKING_API_KEY',
  'AFRICASTALKING_USERNAME',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

// ---------------------------------------------------------------------------
// pawaPay — v2 OpenAPI `amount` pattern (docs.pawapay.io/v2/api-reference/
// openapi_v2.yaml): ^([0]|([1-9][0-9]{0,17}))([.][0-9]{0,3}[1-9])?$ —
// "Amount must follow below requirements or the request will be rejected".
// ---------------------------------------------------------------------------

const PAWAPAY_AMOUNT_PATTERN = /^([0]|([1-9][0-9]{0,17}))([.][0-9]{0,3}[1-9])?$/;

describe("pawaPay: the deposit amount matches pawaPay's documented v2 amount pattern", () => {
  it('the documented pattern rejects what the adapter used to send (toFixed(2)) — the defect being fixed', () => {
    expect(PAWAPAY_AMOUNT_PATTERN.test((100).toFixed(2))).toBe(false); // "100.00"
    expect(PAWAPAY_AMOUNT_PATTERN.test((10.5).toFixed(2))).toBe(false); // "10.50"
  });

  it.each([
    [100, '100'],
    [10.5, '10.5'],
    [49.99, '49.99'],
    [0.5, '0.5'],
    [1000.1, '1000.1'],
    [2500.004, '2500'],
    [7.006, '7.01'],
  ])('formats %s as %s, which the documented pattern accepts', (amount, expected) => {
    expect(formatPawaPayAmount(amount)).toBe(expected);
    expect(PAWAPAY_AMOUNT_PATTERN.test(formatPawaPayAmount(amount))).toBe(true);
  });

  it.each([
    [100, '100'],
    [2500, '2500'],
    [12.5, '12.5'],
  ])('a %s deposit goes out on the wire as amount "%s"', async (amount, expected) => {
    process.env.PAWAPAY_API_KEY = 'pp-test-token';
    const calls = captureFetch(() => json({ depositId: 'd', status: 'ACCEPTED' }));
    const provider = new PawaPayProvider(cfg('pawapay', 'payment', 'test'));
    await provider.processRequest(
      'app1',
      {
        paymentTransactionId: PTX,
        amount,
        currency: 'ZMW',
        paymentMethod: 'mobile_money',
        phoneNumber: '260971234567',
        metadata: { pawapayProvider: 'MTN_MOMO_ZMB' },
      },
      'test',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.sandbox.pawapay.io/v2/deposits');
    const sent = JSON.parse(calls[0].body!);
    expect(sent.amount).toBe(expected);
    expect(PAWAPAY_AMOUNT_PATTERN.test(sent.amount)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Checkout.com — API keys docs: "provide it in the Authorization header with
// the Bearer prefix"; official SDK checkout/checkout-sdk-node: NAS keys get
// `Bearer `, previous-platform (ABC) `sk_test_<uuid>` keys go verbatim;
// merchant-specific base URL `{prefix}.api[.sandbox].checkout.com`.
// ---------------------------------------------------------------------------

describe('Checkout.com: Authorization header and merchant-specific host follow the current docs', () => {
  const payment = { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_x', paymentTransactionId: PTX };
  const approved = () => json({ id: 'pay_1', status: 'Captured', approved: true }, 201);

  async function charge(secrets: Record<string, string>, environment: 'live' | 'test') {
    const calls = captureFetch(approved);
    const provider = new CheckoutComProvider(cfg('checkout', 'payment', environment));
    provider.setSecrets(secrets);
    const event = await provider.processRequest('app1', payment, 'test');
    return { calls, event };
  }

  it.each([
    ['a sandbox NAS key', 'sk_sbox_NOTREALfixtureVALUEzzz', 'test', 'Bearer sk_sbox_NOTREALfixtureVALUEzzz'],
    ['a live NAS key', 'sk_NOTREALfixtureVALUEzzzzzzz', 'live', 'Bearer sk_NOTREALfixtureVALUEzzzzzzz'],
    ['a previous-platform (ABC) sandbox key', 'sk_test_00000000-0000-0000-0000-000000000000', 'test', 'sk_test_00000000-0000-0000-0000-000000000000'],
    ['a previous-platform (ABC) live key', 'sk_00000000-0000-0000-0000-000000000000', 'live', 'sk_00000000-0000-0000-0000-000000000000'],
    ['a key already carrying Bearer', 'Bearer sk_sbox_abc', 'test', 'Bearer sk_sbox_abc'],
  ] as const)('%s is sent as Authorization: %s', async (_label, key, environment, expectedAuth) => {
    const { calls, event } = await charge({ api_key: key }, environment);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(expectedAuth);
    expect(event.status).toBe('success');
  });

  it("with no prefix the legacy shared hosts are unchanged (E11's existing behaviour)", async () => {
    expect((await charge({ api_key: 'sk_sbox_x' }, 'test')).calls[0].url).toBe('https://api.sandbox.checkout.com/payments');
    expect((await charge({ api_key: 'sk_x' }, 'live')).calls[0].url).toBe('https://api.checkout.com/payments');
  });

  it('a configured prefix selects the merchant-specific sandbox and live hosts', async () => {
    const test = await charge({ api_key: 'sk_sbox_x', api_prefix: '1a2b3c4d' }, 'test');
    expect(test.calls[0].url).toBe('https://1a2b3c4d.api.sandbox.checkout.com/payments');
    const live = await charge({ api_key: 'sk_x', api_prefix: '1a2b3c4d' }, 'live');
    expect(live.calls[0].url).toBe('https://1a2b3c4d.api.checkout.com/payments');
  });

  it('the prefix can also come from CHECKOUT_API_PREFIX', async () => {
    process.env.CHECKOUT_API_PREFIX = 'ab12cd34';
    const { calls } = await charge({ api_key: 'sk_x' }, 'live');
    expect(calls[0].url).toBe('https://ab12cd34.api.checkout.com/payments');
  });

  it('a malformed prefix is a configuration error: not configured, and production refuses with NO request to any host', async () => {
    const calls = captureFetch(approved);
    const provider = new CheckoutComProvider(cfg('checkout', 'payment', 'live'));
    provider.setSecrets({ api_key: 'sk_x', api_prefix: 'evil.example.com/x?' });
    expect(provider.isConfigured()).toBe(false);
    process.env.NODE_ENV = 'production';
    await expect(provider.processRequest('app1', payment, 'test')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Africa's Talking — POST /version1/messaging is form-urlencoded in the
// official SDKs (africastalking-node.js lib/sms.js; africastalking-java
// IBulkSMS @FormUrlEncoded with fields username/to/from/message).
// ---------------------------------------------------------------------------

describe("Africa's Talking: SMS send is form-urlencoded, as the official SDKs send it", () => {
  const ok = () =>
    json({
      SMSMessageData: {
        Message: 'Sent to 1/1 Total Cost: KES 0.8000',
        Recipients: [{ statusCode: 101, number: '+254711000111', status: 'Success', cost: 'KES 0.8000', messageId: 'ATPid_1' }],
      },
    }, 201);

  it('sends username/to/message (and from) as an application/x-www-form-urlencoded body, not JSON', async () => {
    process.env.AFRICASTALKING_API_KEY = 'at-key';
    process.env.AFRICASTALKING_USERNAME = 'sandbox';
    const calls = captureFetch(ok);
    const provider = new AfricasTalkingProvider(cfg('africastalking', 'messaging', 'test'));
    const event = await provider.processRequest(
      'app1',
      { recipient: '+254711000111', content: 'Your code is 123 & more', from: 'BISAPI' } as any,
      'test',
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call.headers.apiKey).toBe('at-key');
    expect(call.headers.Accept).toBe('application/json');
    expect(() => JSON.parse(call.body!)).toThrow();
    const form = new URLSearchParams(call.body);
    expect(Object.fromEntries(form)).toEqual({
      username: 'sandbox',
      to: '+254711000111',
      message: 'Your code is 123 & more',
      from: 'BISAPI',
    });
    expect(event.status).toBe('success');
    expect(event.id).toBe('ATPid_1');
  });

  it('omits `from` when the request carries none', async () => {
    process.env.AFRICASTALKING_API_KEY = 'at-key';
    process.env.AFRICASTALKING_USERNAME = 'myapp';
    const calls = captureFetch(ok);
    await new AfricasTalkingProvider(cfg('africastalking', 'messaging', 'live')).processRequest(
      'app1',
      { recipient: '+254711000111', content: 'hi' },
      'test',
    );
    expect(calls[0].url).toBe('https://api.africastalking.com/version1/messaging');
    expect(new URLSearchParams(calls[0].body).has('from')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Twilio — Message resource: `From` is a phone number / alphanumeric sender
// ID / short code / channel address, "required if MessagingServiceSid is not
// passed"; a Messaging Service goes in `MessagingServiceSid` (twilio-csharp
// MessageResource.cs, twilio-node message.ts).
// ---------------------------------------------------------------------------

describe('Twilio: a Messaging Service SID is sent as MessagingServiceSid, never as From', () => {
  const MG = 'MG0123456789abcdef0123456789abcdef';
  const queued = () => json({ sid: 'SM1', status: 'queued' }, 201);

  function twilio(from: string) {
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = from;
    return new TwilioProvider(cfg('twilio', 'messaging', 'live'));
  }

  it('SMS via a Messaging Service: MessagingServiceSid set, no From', async () => {
    const calls = captureFetch(queued);
    const event = await twilio(MG).processRequest('app1', { recipient: '+15551230000', content: 'hello', channel: 'sms' } as any, 'test');
    const form = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json');
    expect(form.get('MessagingServiceSid')).toBe(MG);
    expect(form.has('From')).toBe(false);
    expect(form.get('To')).toBe('+15551230000');
    expect(form.get('Body')).toBe('hello');
    expect(event.status).toBe('success');
  });

  it('WhatsApp via a Messaging Service: To keeps the whatsapp: channel prefix, the SID is never written as "whatsapp:MG..."', async () => {
    const calls = captureFetch(queued);
    await twilio(MG).processRequest('app1', { recipient: '+15551230000', content: 'hi', channel: 'whatsapp' } as any, 'test');
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('MessagingServiceSid')).toBe(MG);
    expect(form.has('From')).toBe(false);
    expect(form.get('To')).toBe('whatsapp:+15551230000');
  });

  it('a phone-number sender is still sent as From (unchanged)', async () => {
    const calls = captureFetch(queued);
    await twilio('+15005550006').processRequest('app1', { recipient: '+15551230000', content: 'x', channel: 'sms' } as any, 'test');
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('From')).toBe('+15005550006');
    expect(form.has('MessagingServiceSid')).toBe(false);
  });

  it('the sending number is reported unknown for a Messaging Service (Twilio picks it from the pool), known for a number', () => {
    expect(twilio(MG).getSenderAddress()).toBeUndefined();
    expect(twilio('+15005550006').getSenderAddress()).toBe('+15005550006');
  });
});

// ---------------------------------------------------------------------------
// Stripe — "Verify webhook signatures manually": during a secret roll
// "Stripe generates one signature for each secret"; compare "the signature
// (or signatures)"; ignore all schemes that aren't v1. (gap register
// PHASE26-04)
// ---------------------------------------------------------------------------

describe('Stripe: every v1 signature in Stripe-Signature is checked (secret-roll window)', () => {
  const rawBody = '{"id":"evt_roll","type":"payment_intent.succeeded"}';
  const sign = (secret: string, t: number) => createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');

  function verify(header: string) {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_current';
    return new StripeProvider(cfg('stripe', 'payment', 'live')).verifyProviderWebhookSignature(rawBody, {
      'stripe-signature': header,
    });
  }

  it('accepts when the matching v1 is listed FIRST and another secret\'s v1 is listed last (the old parser kept only the last)', async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(verify(`t=${t},v1=${sign('whsec_current', t)},v1=${sign('whsec_other', t)}`)).resolves.toBe(true);
  });

  it('accepts when the matching v1 is listed last', async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(verify(`t=${t},v1=${sign('whsec_other', t)},v1=${sign('whsec_current', t)}`)).resolves.toBe(true);
  });

  it('rejects when no v1 matches', async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(verify(`t=${t},v1=${sign('whsec_a', t)},v1=${sign('whsec_b', t)}`)).resolves.toBe(false);
  });

  it('ignores a matching signature under a non-v1 scheme (no downgrade via v0)', async () => {
    const t = Math.floor(Date.now() / 1000);
    await expect(verify(`t=${t},v0=${sign('whsec_current', t)},v1=${sign('whsec_other', t)}`)).resolves.toBe(false);
  });

  it('still enforces the 300s window with several v1 values', async () => {
    const t = Math.floor(Date.now() / 1000) - 301;
    await expect(verify(`t=${t},v1=${sign('whsec_current', t)},v1=${sign('whsec_other', t)}`)).resolves.toBe(false);
  });
});
