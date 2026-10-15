import type { PaymentStatusQueryResult } from '@company/providers';
import type { JobDeps } from './deps';

/**
 * Payment reconciliation (Phase 6 — gap register D4, PHASE3-02).
 *
 * WHAT IT DOES
 *   Finds payments whose outcome the platform does not know:
 *     - 'unknown' — the router timed out / the response was lost after the
 *       request may already have been processed by the provider;
 *     - 'processing' rows whose status has not changed for `staleAfterMs` —
 *       the process crashed between the provider call and recording its
 *       outcome (PHASE3-02), so the row may or may not have been charged;
 *     - stale 'pending' / 'requires_action' rows (an async outcome whose
 *       webhook never arrived; also legacy pre-Phase-6 rows, where 'pending'
 *       is how ambiguous outcomes used to be stored);
 *     - already-escalated 'requires_reconciliation' rows, but only for a
 *       provider that can be queried.
 *   For each one:
 *     - If the adapter has a REAL read-only status query (as of Phase 6:
 *       Stripe only — the other 13 payment adapters have none, see
 *       BaseProvider.supportsPaymentStatusQuery), it asks the provider and,
 *       when the provider reports a final outcome (success / failed /
 *       cancelled) for the same amount and currency, applies it through the
 *       atomic state-machine transition. An inconclusive answer ("not found
 *       yet", still pending, a transport error) is recorded on the row and
 *       retried on a later run; once the payment has been ambiguous for
 *       `escalateAfterMs` it is escalated.
 *     - Otherwise it escalates the row to 'requires_reconciliation' — the
 *       durable operator list served by GET /api/dashboard/payments/
 *       reconciliation — with a reason describing what is known.
 *
 * WHAT IT NEVER DOES
 *   It never calls processRequest()/refund() or any other money-moving
 *   provider operation, and never guesses an outcome. Re-sending a payment
 *   that may already have been processed is exactly the double charge the
 *   certification spec prohibits ("never blindly retry a potentially
 *   chargeable operation"). Without a provider-side status capability the
 *   honest behaviour is SAFE SURFACING FOR HUMAN REVIEW, not "reconciliation".
 */

export interface PaymentReconciliationConfig {
  /** A non-final row whose status has not changed for this long is examined. Default 15 min. */
  staleAfterMs: number;
  /** Minimum gap between two provider status checks of the same row. Default 5 min. */
  recheckAfterMs: number;
  /** An inconclusive row ambiguous for longer than this is escalated to the operator list. Default 60 min. */
  escalateAfterMs: number;
  /** Rows examined per run. Default 100. */
  batchSize: number;
}

export const DEFAULT_PAYMENT_RECONCILIATION_CONFIG: PaymentReconciliationConfig = {
  staleAfterMs: 15 * 60_000,
  recheckAfterMs: 5 * 60_000,
  escalateAfterMs: 60 * 60_000,
  batchSize: 100,
};

export function resolvePaymentReconciliationConfig(
  partial?: Partial<PaymentReconciliationConfig>,
): PaymentReconciliationConfig {
  const out = { ...DEFAULT_PAYMENT_RECONCILIATION_CONFIG };
  for (const [k, v] of Object.entries(partial ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as Record<string, number>)[k] = v;
  }
  return out;
}

/** The row fields the job needs (a transactions row). */
export interface ReconciliationRow {
  id: string;
  appId: string;
  tenantId: string;
  providerId: string;
  providerTransactionId: string | null;
  status: string;
  amount: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  outcomeUnknownAt: Date | null;
}

type TransitionResultLike =
  | { outcome: 'applied'; transaction: unknown }
  | { outcome: 'rejected'; currentStatus: string; transaction: unknown }
  | { outcome: 'not_found' };

/** Subset of @company/database's transactionRepository the job uses (injectable for real-Postgres tests). */
export interface PaymentReconciliationStore {
  findReconciliationCandidates(q: {
    staleBefore: Date;
    recheckBefore: Date;
    queryableProviderIds: readonly string[];
    limit: number;
  }): Promise<ReconciliationRow[]>;
  markReconciliationChecked(id: string, lastCheck: Record<string, unknown>): Promise<unknown>;
  transitionStatus(
    id: string,
    to: string,
    opts?: {
      from?: readonly string[];
      fillProviderTransactionId?: string | null;
      reconciliationReason?: string | null;
      resolution?: { source: 'provider_webhook' | 'provider_status_check' | 'operator'; [k: string]: unknown };
    },
  ): Promise<TransitionResultLike>;
}

export interface PaymentReconciliationReport {
  examined: number;
  /** Read-only provider status queries made. */
  providerStatusChecks: number;
  /** Money-moving provider calls made. Always 0 — there is no code path that makes one. */
  chargeAttempts: 0;
  resolved: Array<{ id: string; from: string; to: string; providerTransactionId: string | null }>;
  updated: Array<{ id: string; from: string; to: string }>;
  escalated: Array<{ id: string; from: string; reason: string }>;
  inconclusive: Array<{ id: string; status: string; detail: string }>;
  errors: Array<{ id: string; error: string }>;
}

const FINAL_FROM_PROVIDER = new Set(['success', 'failed', 'cancelled']);

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function describeStuck(row: ReconciliationRow, now: number): string {
  const since = now - new Date(row.updatedAt).getTime();
  switch (row.status) {
    case 'processing':
      return `stuck_processing: no provider outcome recorded for ${minutes(since)} (the process likely stopped between the provider call and recording its outcome); provider ${row.providerId === 'unassigned' ? 'never recorded' : `'${row.providerId}'`} — it may have been charged`;
    case 'unknown':
      return `ambiguous_outcome: provider '${row.providerId}' outcome unknown for ${minutes(since)}${row.providerTransactionId ? ` (provider id ${row.providerTransactionId})` : ' (no provider id was ever received)'} — it may have been charged`;
    default:
      return `stale_${row.status}: no final outcome from provider '${row.providerId}' for ${minutes(since)}`;
  }
}

export async function runPaymentReconciliationOnce(
  deps: Pick<JobDeps, 'registry'>,
  store: PaymentReconciliationStore,
  config: PaymentReconciliationConfig,
  now: () => number = Date.now,
): Promise<PaymentReconciliationReport> {
  const report: PaymentReconciliationReport = {
    examined: 0,
    providerStatusChecks: 0,
    chargeAttempts: 0,
    resolved: [],
    updated: [],
    escalated: [],
    inconclusive: [],
    errors: [],
  };

  const queryableProviderIds = deps.registry
    .getAllConfigs()
    .filter((c) => c.category === 'payment')
    .map((c) => c.id)
    .filter((id) => {
      try {
        return deps.registry.getProvider(id)?.supportsPaymentStatusQuery() === true;
      } catch {
        return false;
      }
    });

  const t = now();
  const rows = await store.findReconciliationCandidates({
    staleBefore: new Date(t - config.staleAfterMs),
    recheckBefore: new Date(t - config.recheckAfterMs),
    queryableProviderIds,
    limit: config.batchSize,
  });

  for (const candidate of rows) {
    report.examined++;
    // Snapshot: the store may hand back live objects (e.g. an in-memory
    // double); every decision below is about the status as it was READ.
    const row: ReconciliationRow = { ...candidate };
    const ambiguousForMs = t - new Date(row.outcomeUnknownAt ?? row.createdAt).getTime();
    const overdue = ambiguousForMs >= config.escalateAfterMs;

    const escalate = async (reason: string) => {
      if (row.status === 'requires_reconciliation') return; // already on the operator list
      // `from: [row.status]`: if anything (e.g. the provider's webhook)
      // changed the row since it was read, the escalation is simply refused.
      const r = await store.transitionStatus(row.id, 'requires_reconciliation', {
        from: [row.status],
        reconciliationReason: reason,
      });
      if (r.outcome === 'applied') report.escalated.push({ id: row.id, from: row.status, reason });
    };

    try {
      let provider: ReturnType<JobDeps['registry']['getProvider']> | undefined;
      try {
        provider = deps.registry.getProvider(row.providerId);
      } catch {
        provider = undefined;
      }

      if (!provider || !provider.supportsPaymentStatusQuery()) {
        const why = !provider
          ? row.providerId === 'unassigned'
            ? 'the provider that was called was never recorded'
            : `no adapter registered for provider '${row.providerId}'`
          : `provider '${row.providerId}' has no read-only status query`;
        await escalate(`${describeStuck(row, t)}; cannot be checked automatically (${why}) — verify with the provider and resolve manually. Never auto-retried.`);
        continue;
      }

      let result: PaymentStatusQueryResult;
      try {
        report.providerStatusChecks++;
        result = await provider.queryPaymentStatus({
          paymentTransactionId: row.id,
          providerTransactionId: row.providerTransactionId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store.markReconciliationChecked(row.id, { at: new Date(t).toISOString(), kind: 'error', error: message });
        report.inconclusive.push({ id: row.id, status: row.status, detail: `status query failed: ${message}` });
        if (overdue) await escalate(`${describeStuck(row, t)}; provider status query failing (${message})`);
        continue;
      }

      await store.markReconciliationChecked(row.id, { at: new Date(t).toISOString(), ...result });

      if (result.kind === 'found') {
        const amountMismatch =
          (result.amount !== undefined && Math.abs(result.amount - Number(row.amount)) > 0.005) ||
          (result.currency !== undefined && result.currency.toUpperCase() !== row.currency.toUpperCase());
        if (amountMismatch) {
          await escalate(
            `provider_amount_mismatch: provider '${row.providerId}' reports ${result.providerTransactionId} as ${result.providerStatus} for ${result.amount} ${result.currency}, platform recorded ${row.amount} ${row.currency}`,
          );
          continue;
        }
        if (FINAL_FROM_PROVIDER.has(result.status)) {
          const r = await store.transitionStatus(row.id, result.status, {
            from: [row.status],
            fillProviderTransactionId: result.providerTransactionId,
            resolution: {
              source: 'provider_status_check',
              providerId: row.providerId,
              providerTransactionId: result.providerTransactionId,
              providerStatus: result.providerStatus,
              checkedAt: new Date(t).toISOString(),
            },
          });
          if (r.outcome === 'applied') {
            report.resolved.push({ id: row.id, from: row.status, to: result.status, providerTransactionId: result.providerTransactionId });
          }
          continue;
        }
        // Provider says it is still in progress: record the more precise
        // state when the graph allows it, keep watching, escalate if overdue.
        if (result.status !== row.status) {
          const r = await store.transitionStatus(row.id, result.status, {
            from: [row.status],
            fillProviderTransactionId: result.providerTransactionId,
          });
          if (r.outcome === 'applied') report.updated.push({ id: row.id, from: row.status, to: result.status });
        }
        report.inconclusive.push({ id: row.id, status: row.status, detail: `provider reports ${result.providerStatus}` });
        if (overdue) {
          await escalate(`${describeStuck(row, t)}; provider still reports '${result.providerStatus}' after ${minutes(ambiguousForMs)}`);
        }
        continue;
      }

      if (result.kind === 'multiple') {
        await escalate(
          `provider_multiple_matches: provider '${row.providerId}' has ${result.providerTransactionIds.length} payments for this platform transaction (${result.providerTransactionIds.join(', ')})`,
        );
        continue;
      }

      // not_found / unsupported: inconclusive — a provider with no record
      // (yet) is NOT proof that nothing was charged.
      const detail = result.kind === 'not_found' ? result.detail : result.reason;
      report.inconclusive.push({ id: row.id, status: row.status, detail });
      if (overdue || result.kind === 'unsupported') {
        await escalate(`${describeStuck(row, t)}; ${detail}`);
      }
    } catch (err) {
      report.errors.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return report;
}
