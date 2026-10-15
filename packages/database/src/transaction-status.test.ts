import { describe, it, expect } from 'vitest';
import {
  TRANSACTION_STATUSES,
  VALID_TRANSITIONS,
  AMBIGUOUS_STATUSES,
  isAllowedTransition,
  paymentOutcomeFromEvent,
  transactionStatusesAllowedInto,
} from './transaction-status';

/**
 * Phase 6 — DB-free invariants of the payment state machine. The same graph
 * is enforced in SQL (proven on real Postgres in
 * payment-state-machine.postgres.integration.test.ts); these run everywhere.
 */
describe('payment state machine (transaction-status.ts)', () => {
  it('every edge targets a known status', () => {
    for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
      expect(TRANSACTION_STATUSES as readonly string[]).toContain(from);
      for (const to of tos) expect(TRANSACTION_STATUSES as readonly string[]).toContain(to);
    }
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...TRANSACTION_STATUSES].sort());
  });

  it('nothing can ever overwrite a refund / failure / cancellation, or turn anything back into success after it', () => {
    for (const terminal of ['refunded', 'failed', 'cancelled']) expect(VALID_TRANSITIONS[terminal as 'refunded']).toEqual([]);
    expect(transactionStatusesAllowedInto('success').sort()).toEqual(['pending', 'processing', 'requires_action', 'requires_reconciliation', 'unknown']);
    expect(isAllowedTransition('refunded', 'success')).toBe(false);
    expect(isAllowedTransition('partially_refunded', 'success')).toBe(false);
  });

  it('a refund can only follow a success', () => {
    expect(transactionStatusesAllowedInto('refunded').sort()).toEqual(['partially_refunded', 'success']);
  });

  it('no status (in particular no ambiguous one) can move back to processing', () => {
    expect(transactionStatusesAllowedInto('processing')).toEqual([]);
    for (const s of AMBIGUOUS_STATUSES) expect(isAllowedTransition(s, 'processing')).toBe(false);
  });

  it('an escalated payment can only be resolved to a final outcome', () => {
    expect([...VALID_TRANSITIONS.requires_reconciliation].sort()).toEqual(['cancelled', 'failed', 'success']);
  });

  it("paymentOutcomeFromEvent: 'unknown' stays 'unknown' (D4), and the row's own id is never stored as a provider id", () => {
    const txId = '6f1c2f9e-1d2b-4c47-9f0e-2a4b7c2d9e11';
    const timeout = paymentOutcomeFromEvent(txId, { id: txId, providerId: 'stripe', status: 'unknown', amount: 5, error: 'Provider request timed out after 30000ms' }, 'USD');
    expect(timeout).toMatchObject({ status: 'unknown', providerTransactionId: null, providerId: 'stripe', amount: '5', currency: 'USD' });
    expect(timeout.reconciliationReason).toMatch(/^provider_timeout: .*timed out/);

    const async = paymentOutcomeFromEvent(txId, { id: 'pi_123', providerId: 'stripe', status: 'unknown' }, 'USD');
    expect(async).toMatchObject({ status: 'unknown', providerTransactionId: 'pi_123' });
    expect(async.reconciliationReason).toMatch(/^provider_reported_unresolved/);

    expect(paymentOutcomeFromEvent(txId, { id: 'pi_ok', providerId: 'stripe', status: 'success' }, 'USD')).toMatchObject({ status: 'success', providerTransactionId: 'pi_ok' });
    expect(paymentOutcomeFromEvent(txId, { id: 'pi_no', providerId: 'stripe', status: 'failed' }, 'USD').status).toBe('failed');
    expect(paymentOutcomeFromEvent(txId, { id: 'x', providerId: 'p', status: 'pending' }, 'USD').status).toBe('pending');
    expect('reconciliationReason' in paymentOutcomeFromEvent(txId, { id: 'pi_ok', providerId: 'stripe', status: 'success' }, 'USD')).toBe(false);
  });
});
