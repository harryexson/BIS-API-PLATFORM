import { eq, and, asc, desc, isNull, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { getDb } from '../connection';
import { transactions, type Transaction, type NewTransaction } from '../schema';
// Payment status machine (states, transition graph) lives in a DB-free module
// so the simulation's database double can reuse it verbatim.
import {
  AMBIGUOUS_STATUSES,
  REOPEN_FAILED_TRANSITION,
  UNRESOLVED_STATUSES,
  VALID_STATUSES,
  transactionStatusesAllowedInto,
} from '../transaction-status';

export { transactionStatusesAllowedInto, paymentOutcomeFromEvent } from '../transaction-status';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

/** Placeholder provider_id for a row allocated before routing picks a provider (the column is NOT NULL). */
export const UNASSIGNED_PROVIDER_ID = 'unassigned';

export interface PaymentAttemptInput {
  appId: string;
  tenantId: string;
  amount: string;
  currency: string;
  paymentMethod?: string | null;
  idempotencyKey?: string | null;
  /** Provider the caller asked for, if any — otherwise UNASSIGNED_PROVIDER_ID until the outcome is recorded. */
  providerId?: string | null;
  metadata?: unknown;
}

export interface PaymentAttemptOutcome {
  providerId: string;
  /**
   * The PROVIDER's own id for this payment, or null when none was received
   * (e.g. a router timeout: the provider may have created one, but the
   * platform never learnt it). Never a locally invented placeholder.
   */
  providerTransactionId: string | null;
  status: string;
  amount?: string;
  currency?: string;
  metadata?: unknown;
  /** Recorded in reconciliation_reason when `status` is ambiguous ('unknown'). */
  reconciliationReason?: string | null;
}

/** How an ambiguous ('unknown' / 'requires_reconciliation') outcome got resolved. */
export interface ReconciliationResolution {
  source: 'provider_webhook' | 'provider_status_check' | 'operator';
  [key: string]: unknown;
}

export interface TransitionOptions {
  /**
   * Further restrict the prior statuses the transition is accepted from
   * (intersected with the state machine's own allowed-prior set — this can
   * only narrow the graph, never widen it).
   */
  from?: readonly string[];
  providerId?: string;
  /** Overwrites provider_transaction_id (recordOutcome: the row has none yet). */
  providerTransactionId?: string | null;
  /** Sets provider_transaction_id only if it is still NULL (never overwrites a known provider id). */
  fillProviderTransactionId?: string | null;
  amount?: string;
  currency?: string;
  metadata?: unknown;
  reconciliationReason?: string | null;
  /**
   * Set by an explicit reconciler (provider status check / operator):
   * records reconciliation_resolved_at + reconciliation_resolution. Without
   * it, leaving 'unknown'/'requires_reconciliation' still stamps
   * reconciliation_resolved_at.
   */
  resolution?: ReconciliationResolution;
}

/**
 * Result of an atomic state transition. The decision is made by ONE
 * conditional UPDATE (`... WHERE id = $id AND status = ANY($allowedFrom)`);
 * on a miss, one follow-up read classifies it (informational only — it is
 * not part of the decision, so it cannot reintroduce the D11 race).
 */
export type TransitionResult =
  | { outcome: 'applied'; transaction: Transaction }
  /** The row exists but its current status does not allow this transition. */
  | { outcome: 'rejected'; currentStatus: string; transaction: Transaction }
  | { outcome: 'not_found' };

export class InvalidTransactionStatusError extends Error {
  constructor(status: string) {
    super(`Invalid transaction status: ${status}`);
    this.name = 'InvalidTransactionStatusError';
  }
}

export interface ReconciliationCandidateQuery {
  /** Unresolved rows whose status has not changed since before this instant are candidates. */
  staleBefore: Date;
  /** ...and that were not already checked by the job since this instant. */
  recheckBefore: Date;
  /**
   * Providers that support a read-only status query: rows ALREADY escalated
   * to requires_reconciliation are only re-checked for these (nothing else
   * can be learnt automatically about the rest).
   */
  queryableProviderIds: readonly string[];
  limit: number;
}

export interface ReconciliationListQuery {
  limit?: number;
  appId?: string;
  /** Also include 'unknown' rows not yet escalated (default: only requires_reconciliation). */
  includeUnknown?: boolean;
}

const AMBIGUOUS_SQL_LIST = sql.join(
  AMBIGUOUS_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * Payment-attempt lifecycle (gap register E7/D5) and the payment state
 * machine (D4/D11, Phase 6): the platform's `transactions` row is allocated
 * BEFORE any provider is called, so its id (the `payment_transaction_id`
 * every adapter's deterministic idempotency identity is derived from)
 * exists and is durable first.
 *
 *   allocate         → INSERT status 'processing' (ON CONFLICT on
 *                      idx_transactions_idempotency DO NOTHING — returns
 *                      undefined when the key already has a transaction)
 *   transitionStatus → the ONLY way a status changes: one conditional UPDATE
 *                      whose WHERE clause carries the state machine's allowed
 *                      prior statuses (see ../transaction-status.ts)
 *   recordOutcome    → transitionStatus(... from: ['processing']) plus the
 *                      provider's identifiers
 *   reopenFailed     → UPDATE 'failed' → 'processing' only when no provider
 *                      transaction id was ever recorded AND the attempt was
 *                      never ambiguous, so a client retry under the same
 *                      Idempotency-Key reuses the SAME row and therefore the
 *                      SAME provider idempotency identity.
 *
 * Each is a single statement (no transaction needed — neon-http cannot run
 * one, see gap register D1). Factory form so the exact SQL can be exercised
 * against a real Postgres in tests.
 */
export function createPaymentAttemptRepository(dbProvider: () => AnyPgDb) {
  async function findById(id: string): Promise<Transaction | undefined> {
    const rows = await dbProvider().select().from(transactions).where(eq(transactions.id, id)).limit(1);
    return rows[0];
  }

  async function transitionStatus(id: string, to: string, opts: TransitionOptions = {}): Promise<TransitionResult> {
    if (!VALID_STATUSES.has(to)) throw new InvalidTransactionStatusError(to);
    const allowedFrom = transactionStatusesAllowedInto(to).filter((s) => !opts.from || opts.from.includes(s));
    const db = dbProvider();

    let applied: Transaction | undefined;
    if (allowedFrom.length > 0) {
      const toAmbiguous = (AMBIGUOUS_STATUSES as readonly string[]).includes(to);
      const set: Record<string, unknown> = {
        status: to,
        updatedAt: sql`now()`,
      };
      if (opts.providerId !== undefined) set.providerId = opts.providerId;
      if (opts.providerTransactionId !== undefined) set.providerTransactionId = opts.providerTransactionId;
      if (opts.fillProviderTransactionId) {
        set.providerTransactionId = sql`COALESCE(${transactions.providerTransactionId}, ${opts.fillProviderTransactionId})`;
      }
      if (opts.amount !== undefined) set.amount = opts.amount;
      if (opts.currency !== undefined) set.currency = opts.currency;
      if (opts.metadata !== undefined) set.metadata = opts.metadata;
      if (opts.reconciliationReason !== undefined) set.reconciliationReason = opts.reconciliationReason;
      if (toAmbiguous) {
        // First entry into ambiguity is remembered forever (blocks reopenFailed).
        set.outcomeUnknownAt = sql`COALESCE(${transactions.outcomeUnknownAt}, now())`;
        if (to === 'requires_reconciliation') {
          set.reconciliationRequiredAt = sql`COALESCE(${transactions.reconciliationRequiredAt}, now())`;
        }
      } else if (opts.resolution) {
        // An explicit reconciler (provider status check / operator) resolved
        // this row's outcome — recorded whatever unresolved status it left.
        set.reconciliationResolvedAt = sql`now()`;
        set.reconciliationResolution = sql`${JSON.stringify(opts.resolution)}::jsonb`;
      } else {
        // Leaving an ambiguous status = an ambiguous outcome got resolved.
        // In an UPDATE's SET list, column references read the PRE-update row.
        const wasAmbiguous: SQL = sql`${transactions.status} IN (${AMBIGUOUS_SQL_LIST})`;
        set.reconciliationResolvedAt = sql`CASE WHEN ${wasAmbiguous} THEN now() ELSE ${transactions.reconciliationResolvedAt} END`;
      }
      const rows = await db
        .update(transactions)
        .set(set as never)
        .where(and(eq(transactions.id, id), inArray(transactions.status, allowedFrom)))
        .returning();
      applied = rows[0];
    }
    if (applied) return { outcome: 'applied', transaction: applied };

    const current = await findById(id);
    if (!current) return { outcome: 'not_found' };
    return { outcome: 'rejected', currentStatus: current.status, transaction: current };
  }

  return {
    findById,
    transitionStatus,

    async allocate(input: PaymentAttemptInput): Promise<Transaction | undefined> {
      const db = dbProvider();
      const rows = await db
        .insert(transactions)
        .values({
          appId: input.appId,
          tenantId: input.tenantId,
          providerId: input.providerId || UNASSIGNED_PROVIDER_ID,
          providerTransactionId: null,
          status: 'processing',
          amount: input.amount,
          currency: input.currency,
          paymentMethod: input.paymentMethod ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({ target: [transactions.appId, transactions.tenantId, transactions.idempotencyKey] })
        .returning();
      return rows[0];
    },

    /**
     * Records the provider's outcome on a row that is still 'processing'.
     * Returns undefined when the row is no longer 'processing' (a duplicate
     * or late outcome write never overwrites a recorded outcome).
     */
    async recordOutcome(id: string, outcome: PaymentAttemptOutcome): Promise<Transaction | undefined> {
      const result = await transitionStatus(id, outcome.status, {
        from: ['processing'],
        providerId: outcome.providerId,
        providerTransactionId: outcome.providerTransactionId,
        amount: outcome.amount,
        currency: outcome.currency,
        metadata: outcome.metadata,
        ...(outcome.reconciliationReason !== undefined ? { reconciliationReason: outcome.reconciliationReason } : {}),
      });
      return result.outcome === 'applied' ? result.transaction : undefined;
    },

    async reopenFailed(id: string): Promise<Transaction | undefined> {
      const db = dbProvider();
      const rows = await db
        .update(transactions)
        .set({ status: REOPEN_FAILED_TRANSITION.to, updatedAt: sql`now()` as unknown as Date })
        .where(
          and(
            eq(transactions.id, id),
            eq(transactions.status, REOPEN_FAILED_TRANSITION.from),
            isNull(transactions.providerTransactionId),
            // An attempt whose outcome was EVER ambiguous may have charged —
            // it is never re-opened for another attempt (Phase 6, D4).
            isNull(transactions.outcomeUnknownAt),
          ),
        )
        .returning();
      return rows[0];
    },

    /**
     * Rows the reconciliation job should look at (oldest first):
     *  - 'processing' / 'pending' / 'requires_action' / 'unknown' rows whose
     *    status has not changed since `staleBefore` (stuck mid-call after a
     *    crash — PHASE3-02 —, a lost response, or an async outcome that never
     *    arrived);
     *  - 'requires_reconciliation' rows of a provider that supports a status
     *    query (they can still be resolved automatically);
     * in both cases skipping rows the job already checked since `recheckBefore`.
     */
    async findReconciliationCandidates(q: ReconciliationCandidateQuery): Promise<Transaction[]> {
      const db = dbProvider();
      const notRecentlyChecked = sql`(${transactions.reconciliationCheckedAt} IS NULL OR ${transactions.reconciliationCheckedAt} < ${q.recheckBefore.toISOString()}::timestamptz)`;
      const stuck = and(
        inArray(transactions.status, ['processing', 'pending', 'requires_action', 'unknown']),
        sql`${transactions.updatedAt} < ${q.staleBefore.toISOString()}::timestamptz`,
      );
      const escalatedButQueryable =
        q.queryableProviderIds.length > 0
          ? and(eq(transactions.status, 'requires_reconciliation'), inArray(transactions.providerId, [...q.queryableProviderIds]))
          : undefined;
      const which = escalatedButQueryable ? sql`(${stuck} OR ${escalatedButQueryable})` : stuck;
      return db
        .select()
        .from(transactions)
        .where(and(which, notRecentlyChecked))
        .orderBy(transactions.updatedAt, transactions.id)
        .limit(q.limit);
    },

    /** Records one read-only provider status check (no status change). */
    async markReconciliationChecked(id: string, lastCheck: Record<string, unknown>): Promise<Transaction | undefined> {
      const db = dbProvider();
      const rows = await db
        .update(transactions)
        .set({
          reconciliationCheckedAt: sql`now()` as unknown as Date,
          reconciliationCheckCount: sql`${transactions.reconciliationCheckCount} + 1` as unknown as number,
          reconciliationLastCheck: lastCheck,
        })
        .where(eq(transactions.id, id))
        .returning();
      return rows[0];
    },

    /** The operator reconciliation list: escalated (and optionally still-unknown) payments, oldest first. */
    async listRequiringReconciliation(q: ReconciliationListQuery = {}): Promise<Transaction[]> {
      const db = dbProvider();
      const statuses = q.includeUnknown ? ['requires_reconciliation', 'unknown'] : ['requires_reconciliation'];
      const conds = [inArray(transactions.status, statuses)];
      if (q.appId) conds.push(eq(transactions.appId, q.appId));
      return db
        .select()
        .from(transactions)
        .where(and(...conds))
        .orderBy(sql`COALESCE(${transactions.reconciliationRequiredAt}, ${transactions.outcomeUnknownAt}, ${transactions.updatedAt})`, transactions.id)
        .limit(Math.min(Math.max(q.limit ?? 100, 1), 500));
    },

    /** Counts unresolved rows by status (operator dashboard / reconciliation report). */
    async countUnresolvedByStatus(): Promise<Record<string, number>> {
      const db = dbProvider();
      const rows = await db
        .select({ status: transactions.status, n: sql<number>`count(*)::int` })
        .from(transactions)
        .where(inArray(transactions.status, [...UNRESOLVED_STATUSES]))
        .groupBy(transactions.status);
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    },
  };
}

export type PaymentAttemptRepository = ReturnType<typeof createPaymentAttemptRepository>;

const paymentAttempts = createPaymentAttemptRepository(() => getDb() as unknown as AnyPgDb);

export const transactionRepository = {
  allocatePaymentAttempt: paymentAttempts.allocate,
  recordPaymentAttemptOutcome: paymentAttempts.recordOutcome,
  reopenFailedPaymentAttempt: paymentAttempts.reopenFailed,
  transitionStatus: paymentAttempts.transitionStatus,
  findReconciliationCandidates: paymentAttempts.findReconciliationCandidates,
  markReconciliationChecked: paymentAttempts.markReconciliationChecked,
  listRequiringReconciliation: paymentAttempts.listRequiringReconciliation,
  countUnresolvedByStatus: paymentAttempts.countUnresolvedByStatus,
  findById: paymentAttempts.findById,

  /**
   * Phase 7 (gap register GW-1.1 / D16): `providerId`, when given, scopes the
   * match to rows that provider actually produced — the inbound webhook
   * route derives a webhook's application/tenant from the row this returns,
   * so a provider id that happens to collide with another provider's id must
   * not attribute the webhook to that other provider's (possibly other
   * tenant's) payment. Oldest row first, matching persistEffectsOnce.
   */
  async findByProviderTransactionId(providerTxId: string, providerId?: string): Promise<Transaction | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(transactions)
      .where(
        providerId
          ? and(eq(transactions.providerTransactionId, providerTxId), eq(transactions.providerId, providerId))
          : eq(transactions.providerTransactionId, providerTxId),
      )
      .orderBy(asc(transactions.createdAt))
      .limit(1);
    return rows[0];
  },

  async create(data: NewTransaction): Promise<Transaction> {
    const db = getDb();
    const rows = await db.insert(transactions).values(data).returning();
    return rows[0];
  },

  /**
   * Applies a status change through the state machine. D11: this used to
   * read the current status, validate the transition in JS, then write
   * unconditionally — two concurrent callers could both validate against the
   * same stale status and the last write silently won (e.g. a late
   * 'success' overwriting 'refunded'). It is now the single conditional
   * UPDATE in transitionStatus(). Kept for its old contract: returns the
   * updated row, the unchanged current row when the transition is not
   * allowed, or undefined when the row does not exist.
   */
  async updateStatus(id: string, status: string): Promise<Transaction | undefined> {
    const result = await paymentAttempts.transitionStatus(id, status);
    if (result.outcome === 'not_found') return undefined;
    if (result.outcome === 'rejected') {
      console.warn(`[transactions] Ignoring invalid transition: ${result.currentStatus} → ${status} for tx ${id}`);
    }
    return result.transaction;
  },

  async findByAppAndIdempotencyKey(
    appId: string,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Transaction | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.appId, appId),
          eq(transactions.tenantId, tenantId),
          eq(transactions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0];
  },

  async findByAppId(appId: string, limit: number = 50): Promise<Transaction[]> {
    const db = getDb();
    return db
      .select()
      .from(transactions)
      .where(eq(transactions.appId, appId))
      .orderBy(desc(transactions.createdAt))
      .limit(limit);
  },

  async count(): Promise<number> {
    const db = getDb();
    const { count } = await import('drizzle-orm');
    const rows = await db.select({ value: count() }).from(transactions);
    return rows[0]?.value ?? 0;
  },
};
