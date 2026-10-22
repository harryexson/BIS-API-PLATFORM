import { describe, it, expect, afterEach, vi } from 'vitest';
import { ProviderConfig } from '@company/schemas';
import { CheckoutComProvider } from './checkout';
import { PaystackProvider } from './paystack';
import { AuthorizeNetProvider } from './authorizenet';

// Phase 17-18 (gap register F11) — the platform's payment amount is in MAJOR
// currency units end to end (gateway → RoutingEngine.routePayment →
// adapter.processRequest), and each adapter converts it to its provider's
// own wire format. The other ten adapters already pin that conversion in
// their own tests (stripe/adyen/square: 10 → 1000 minor units;
// braintree/nmi/paypal: 10 → "10.00"; pawapay: 100 → "100.00";
// flutterwave/paychangu/airwallex: decimal passed as-is). These three had no
// test of the amount they actually send; this pins it for the same
// major-unit input, 49.99, over the real HTTP path (fetch stubbed).

const PAYMENT_TRANSACTION_ID = '5b0c8a2e-3f4d-4c1a-9e6b-7a8d9c0e1f23';

function config(id: string, name: string): ProviderConfig {
  return { id, name, category: 'payment', status: 'online', weight: 50, latencyMin: 1, latencyMax: 2 };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function captureFetch(response: unknown, status = 200) {
  const spy = vi.fn().mockImplementation(async () => jsonResponse(response, status));
  vi.stubGlobal('fetch', spy);
  return () => JSON.parse(spy.mock.calls[0][1].body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('F11 — major-unit amounts reach each provider in that provider\'s own unit', () => {
  it('Checkout.com: 49.99 USD → amount 4999 (minor units, as the Payments API requires)', async () => {
    const sent = captureFetch({ id: 'pay_cko_1', status: 'Captured', approved: true }, 201);
    const provider = new CheckoutComProvider(config('checkout', 'Checkout.com'));
    provider.setSecrets({ api_key: 'sk_sbox_test' });
    const event = await provider.processRequest(
      'app1',
      { amount: 49.99, currency: 'USD', paymentMethod: 'card', paymentToken: 'tok_test', paymentTransactionId: PAYMENT_TRANSACTION_ID },
      'test',
    );
    expect(sent().amount).toBe(4999);
    expect(event).toMatchObject({ status: 'success', amount: 49.99 });
  });

  it('Paystack: 49.99 NGN → amount 4999 (kobo, as /transaction/initialize requires)', async () => {
    const sent = captureFetch({ status: true, data: { reference: 'ref_1', authorization_url: 'https://checkout.paystack.com/x' } });
    const provider = new PaystackProvider(config('paystack', 'Paystack'));
    provider.setSecrets({ api_key: 'sk_test_paystack' });
    const event = await provider.processRequest(
      'app1',
      { amount: 49.99, currency: 'NGN', paymentMethod: 'card', metadata: { email: 'payer@example.com' }, paymentTransactionId: PAYMENT_TRANSACTION_ID },
      'test',
    );
    expect(sent().amount).toBe(4999);
    expect(event).toMatchObject({ status: 'pending', amount: 49.99 });
  });

  it('Authorize.Net: 49.99 USD → amount "49.99" (decimal string, as createTransactionRequest requires)', async () => {
    const sent = captureFetch({
      messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] },
      transactionResponse: { responseCode: '1', transId: '60123456789' },
    });
    const provider = new AuthorizeNetProvider(config('authorizenet', 'Authorize.Net'));
    provider.setSecrets({ login_id: 'login', transaction_key: 'txkey' });
    const event = await provider.processRequest(
      'app1',
      { amount: 49.99, currency: 'USD', paymentMethod: 'card', paymentToken: 'opaque-nonce', paymentTransactionId: PAYMENT_TRANSACTION_ID },
      'test',
    );
    expect(sent().createTransactionRequest.transactionRequest.amount).toBe('49.99');
    expect(event).toMatchObject({ status: 'success', amount: 49.99 });
  });
});
