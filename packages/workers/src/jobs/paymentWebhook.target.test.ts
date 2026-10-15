import { describe, it, expect } from 'vitest';
import { paymentWebhookTransactionTarget } from './paymentWebhook';

/** Phase 6 — which transactions-row change a (Stripe-shaped) payment webhook implies. */
describe('paymentWebhookTransactionTarget', () => {
  it("matches a charge.* event on its PaymentIntent (the id the platform stored), not the charge id", () => {
    const t = paymentWebhookTransactionTarget('charge.succeeded', { id: 'ch_1', payment_intent: 'pi_1' });
    expect(t).toEqual({ providerTransactionId: 'pi_1', toStatus: 'success', paymentTransactionId: null });
  });

  it('passes the platform transaction id from metadata through (for rows whose provider id was never received)', () => {
    const t = paymentWebhookTransactionTarget('payment_intent.succeeded', { id: 'pi_2', metadata: { bisPaymentTransactionId: 'abc' } });
    expect(t).toEqual({ providerTransactionId: 'pi_2', toStatus: 'success', paymentTransactionId: 'abc' });
  });

  it('maps the event types onto the state machine', () => {
    const to = (type: string, obj: Record<string, unknown> = { id: 'x' }) => paymentWebhookTransactionTarget(type, obj).toStatus;
    expect(to('charge.failed')).toBe('failed');
    expect(to('payment_intent.payment_failed')).toBe('failed');
    expect(to('charge.refunded')).toBe('refunded');
    expect(to('charge.refunded', { id: 'x', refunded: true })).toBe('refunded');
    expect(to('charge.refunded', { id: 'x', refunded: false, amount_refunded: 100 })).toBe('partially_refunded');
    expect(to('charge.pending')).toBe('pending');
    expect(to('payment_intent.processing')).toBe('pending');
    expect(to('payment_intent.requires_action')).toBe('requires_action');
    expect(to('payment_intent.canceled')).toBe('cancelled');
    expect(to('customer.created')).toBeNull();
  });

  it('keeps the legacy fallbacks (data.object.id, then the provider event id)', () => {
    expect(paymentWebhookTransactionTarget('charge.succeeded', { id: 'tx_legacy' }).providerTransactionId).toBe('tx_legacy');
    expect(paymentWebhookTransactionTarget('charge.succeeded', undefined, 'evt_1').providerTransactionId).toBe('evt_1');
  });
});
