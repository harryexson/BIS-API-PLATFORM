/**
 * The payment state machine (gap register D4 / D11, Phase 6).
 *
 * No database dependency on purpose: repositories/transactions.ts and
 * repositories/webhook-events.ts push it into SQL (`... WHERE status =
 * ANY(<allowed prior statuses>)`), the simulation's in-memory database double
 * (packages/simulation/src/db.ts) imports it directly, and migration 0016's
 * CHECK constraint (chk_transactions_status) lists exactly TRANSACTION_STATUSES.
 *
 * ---------------------------------------------------------------------------
 * STATES (stored value — meaning; certification-spec name in brackets)
 * ---------------------------------------------------------------------------
 *   processing              The platform's row is allocated and a provider
 *                           call is (or was) in flight. [created + processing:
 *                           a row is only ever allocated immediately before
 *                           the provider call, so there is no separately
 *                           observable "created" state.]
 *   pending                 The provider ACCEPTED the payment but has not
 *                           finished it (async rails, e.g. charge.pending /
 *                           payment_intent.processing). Also the legacy value
 *                           the gateway wrote for ambiguous outcomes before
 *                           Phase 6 (D4) — the reconciliation sweep picks up
 *                           stale 'pending' rows for that reason.
 *   requires_action         The provider is waiting on the payer (SCA/3DS,
 *                           mobile-money approval). [requires_action]
 *   success                 Money moved. [succeeded — the stored value stays
 *                           'success' because it is the platform-wide
 *                           TransactionEvent status vocabulary every API
 *                           response, event and simulation already uses.]
 *   failed                  Definitively not charged. [failed]
 *   cancelled               Cancelled/voided before capture. [cancelled]
 *   partially_refunded      Some, not all, of a successful charge refunded.
 *   refunded                Fully refunded. [refunded]
 *   unknown                 AMBIGUOUS: the request may or may not have been
 *                           processed by the provider (router timeout / lost
 *                           response — "network death after the provider
 *                           processed but before the response was received").
 *                           NEVER retried as a fresh charge by any code path;
 *                           resolved only by the provider's own webhook, a
 *                           read-only provider status check, or an operator.
 *                           [unknown]
 *   requires_reconciliation Escalated: the platform could not resolve the
 *                           outcome automatically (no provider status-check
 *                           capability, provider has no record yet, or a crash
 *                           left the row 'processing' with no recorded
 *                           outcome). Surfaced on the operator reconciliation
 *                           list; still resolvable by a late provider webhook.
 *                           [RECONCILIATION_REQUIRED]
 *
 * ---------------------------------------------------------------------------
 * TRANSITION GRAPH (enforced atomically in SQL, never by a JS read-then-write)
 * ---------------------------------------------------------------------------
 *   processing              -> success | failed | unknown | cancelled | pending
 *                              | requires_action | requires_reconciliation
 *   pending                 -> success | failed | unknown | cancelled
 *                              | requires_action | requires_reconciliation
 *   requires_action         -> success | failed | unknown | cancelled | pending
 *                              | requires_reconciliation
 *   unknown                 -> success | failed | cancelled | pending
 *                              | requires_action | requires_reconciliation
 *   requires_reconciliation -> success | failed | cancelled
 *   success                 -> refunded | partially_refunded
 *   partially_refunded      -> partially_refunded (a further partial refund)
 *                              | refunded
 *   failed                  -> (terminal for every generic transition; see
 *                              REOPEN_FAILED_TRANSITION below)
 *   cancelled, refunded     -> (terminal)
 *
 * Deliberately ABSENT edges (each was allowed, or reachable, before Phase 6):
 *   refunded/partially_refunded/failed/cancelled -> success   a late or
 *       out-of-order "succeeded" webhook can never overwrite a refund or a
 *       definitive outcome (PHASE4-03 / D11).
 *   processing/pending/unknown -> refunded   a refund can only follow a
 *       recorded success.
 *   unknown/requires_reconciliation -> processing   an ambiguous attempt is
 *       never re-opened for another charge attempt.
 *   failed -> pending  (the old "allow retry from failed" edge).
 */

export const TRANSACTION_STATUSES = [
  'processing',
  'pending',
  'requires_action',
  'success',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
  'unknown',
  'requires_reconciliation',
] as const;

export type PaymentTransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const VALID_STATUSES: ReadonlySet<string> = new Set<string>(TRANSACTION_STATUSES);

export const VALID_TRANSITIONS: Readonly<Record<PaymentTransactionStatus, readonly PaymentTransactionStatus[]>> = {
  processing: ['success', 'failed', 'unknown', 'cancelled', 'pending', 'requires_action', 'requires_reconciliation'],
  pending: ['success', 'failed', 'unknown', 'cancelled', 'requires_action', 'requires_reconciliation'],
  requires_action: ['success', 'failed', 'unknown', 'cancelled', 'pending', 'requires_reconciliation'],
  unknown: ['success', 'failed', 'cancelled', 'pending', 'requires_action', 'requires_reconciliation'],
  requires_reconciliation: ['success', 'failed', 'cancelled'],
  success: ['refunded', 'partially_refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
};

/**
 * The single non-generic edge: failed -> processing, applied ONLY by
 * transactionRepository.reopenFailedPaymentAttempt, which additionally
 * requires (in the same UPDATE's WHERE clause) that the failed attempt never
 * received a provider transaction id AND never had an ambiguous outcome
 * (outcome_unknown_at IS NULL). It lets a client retry a definitively
 * un-attempted payment under the same Idempotency-Key reuse the same row (and
 * therefore the same provider idempotency identity). It is not in
 * VALID_TRANSITIONS so no generic transition can ever move a row back into
 * 'processing'.
 */
export const REOPEN_FAILED_TRANSITION = { from: 'failed', to: 'processing' } as const;

/** Statuses whose outcome is not yet known/final — what the reconciliation sweep looks at. */
export const UNRESOLVED_STATUSES: readonly PaymentTransactionStatus[] = [
  'processing',
  'pending',
  'requires_action',
  'unknown',
  'requires_reconciliation',
];

/** Statuses that mean "the platform does not know whether money moved". */
export const AMBIGUOUS_STATUSES: readonly PaymentTransactionStatus[] = ['unknown', 'requires_reconciliation'];

export function isValidTransactionStatus(status: string): status is PaymentTransactionStatus {
  return VALID_STATUSES.has(status);
}

export function isAllowedTransition(from: string, to: string): boolean {
  if (!isValidTransactionStatus(from) || !isValidTransactionStatus(to)) return false;
  return (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * The statuses a transaction may move INTO `status` from, per
 * VALID_TRANSITIONS. Used to push the transition guard into a single SQL
 * statement (`... WHERE status = ANY(<allowedFrom>)`) so it is evaluated
 * atomically by Postgres on the row's current status — see
 * repositories/transactions.ts transitionStatus() and
 * repositories/webhook-events.ts persistEffectsOnce. Empty for an unknown status.
 */
export function transactionStatusesAllowedInto(status: string): string[] {
  if (!VALID_STATUSES.has(status)) return [];
  return (Object.entries(VALID_TRANSITIONS) as Array<[string, readonly string[]]>)
    .filter(([, to]) => to.includes(status))
    .map(([from]) => from);
}

/**
 * Maps a routing outcome (TransactionEvent) onto the pre-allocated row's
 * outcome (gap register D4). Shared by the gateway and the real-Postgres
 * tests so both exercise exactly the same mapping.
 *
 *  - 'success' / 'failed' / 'pending' map 1:1.
 *  - 'unknown' is stored as 'unknown' — a distinct ambiguous state — and is
 *    NOT collapsed into 'pending' any more.
 *  - The provider's own id is stored only if one was actually received. The
 *    router's timeout event carries the platform's own paymentTransactionId
 *    as its id (packages/routing — it has no provider id to give), so an
 *    event whose id IS the row id means "no provider id known" → NULL. The
 *    row keeps its own stable id; nothing random is ever stored.
 */
export function paymentOutcomeFromEvent(
  paymentTransactionId: string,
  event: {
    id: string;
    providerId: string;
    status: string;
    amount?: number;
    currency?: string;
    error?: string;
    decisionReason?: string;
  },
  fallbackCurrency: string,
): {
  providerId: string;
  providerTransactionId: string | null;
  status: PaymentTransactionStatus;
  amount?: string;
  currency?: string;
  reconciliationReason?: string;
} {
  const status: PaymentTransactionStatus =
    event.status === 'success' ? 'success'
      : event.status === 'failed' ? 'failed'
        : event.status === 'pending' ? 'pending'
          : 'unknown';
  const providerTransactionId = event.id && event.id !== paymentTransactionId ? event.id : null;
  return {
    providerId: event.providerId,
    providerTransactionId,
    status,
    amount: event.amount !== undefined ? String(event.amount) : undefined,
    currency: event.currency || fallbackCurrency,
    ...(status === 'unknown'
      ? {
          reconciliationReason: providerTransactionId
            ? `provider_reported_unresolved: provider '${event.providerId}' returned an unresolved status for ${providerTransactionId}`
            : `provider_timeout: no response from provider '${event.providerId}'${event.error ? ` (${event.error})` : ''} — the request may have been processed`,
        }
      : {}),
  };
}
