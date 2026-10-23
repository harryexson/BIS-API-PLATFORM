import { logger } from '@company/observability';
import { JobProcessor, WorkerConfig } from '../types';
import { JobDeps } from './deps';
import {
  outboxEventRepository,
  DEFAULT_OUTBOX_RETRY_POLICY,
  DEFAULT_OUTBOX_STALE_AFTER_MS,
  type ClaimedOutboxEvent,
  type OutboxEventRepository,
} from '@company/database';
import type { EventBus } from '@company/events';
import type { TransactionEvent } from '@company/schemas';

/**
 * Transactional-outbox consumer (gap register D10, Phase 5).
 *
 * One poll:
 *   1. rescue: `processing` rows whose claim went stale (claimed_at older
 *      than staleAfterMs — their worker crashed) go back to `pending`, or to
 *      `dead` once they have used maxAttempts claims;
 *   2. claim exactly `batchSize` due `pending` rows (FOR UPDATE SKIP LOCKED,
 *      so any number of pollers on any number of replicas take disjoint rows);
 *   3. per row: renew the claim (heartbeat + fence — skip the row if it was
 *      rescued out from under us), dispatch it with a timeout, then
 *      complete it — or record the failure, which schedules a backed-off
 *      retry or dead-letters it. Dead letters are listed/replayed through
 *      outboxEventRepository.listDead / replayDead (and the admin routes).
 *
 * Guarantees: no row is ever silently dropped (every path ends in
 * completed, pending-for-retry, still-processing-to-be-rescued, or dead and
 * listable); no two workers hold the same row at once; a worker that lost
 * its claim cannot complete/fail the row. Delivery is AT LEAST ONCE — the
 * narrow window "dispatch succeeded, then the completion write failed or the
 * process died" re-dispatches after the stale window — so the dispatcher
 * passes the outbox row id downstream as the event id, a stable idempotency
 * key across retries and replays.
 */

export type OutboxStore = Pick<OutboxEventRepository, 'claimBatch' | 'renewClaim' | 'complete' | 'fail' | 'rescueStale'>;

/** Performs the real-world effect of one outbox row. Throw to retry it. */
export type OutboxDispatcher = (event: ClaimedOutboxEvent) => Promise<void>;

export interface OutboxConsumerConfig {
  batchSize: number;
  /** A processing row whose claim is older than this is presumed abandoned. */
  staleAfterMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A dispatch that takes longer is failed (and retried). Capped at staleAfterMs / 2. */
  dispatchTimeoutMs: number;
  /** Max stale rows rescued per poll. */
  rescueLimit: number;
}

export const DEFAULT_OUTBOX_CONSUMER_CONFIG: OutboxConsumerConfig = {
  batchSize: 10,
  staleAfterMs: DEFAULT_OUTBOX_STALE_AFTER_MS,
  maxAttempts: DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts,
  baseDelayMs: DEFAULT_OUTBOX_RETRY_POLICY.baseDelayMs,
  maxDelayMs: DEFAULT_OUTBOX_RETRY_POLICY.maxDelayMs,
  dispatchTimeoutMs: 30_000,
  rescueLimit: 100,
};

export function resolveOutboxConsumerConfig(config?: WorkerConfig['outbox']): OutboxConsumerConfig {
  return { ...DEFAULT_OUTBOX_CONSUMER_CONFIG, ...(config ?? {}) };
}

export interface OutboxPollResult {
  rescued: number;
  rescuedToDead: number;
  claimed: number;
  completed: number;
  retried: number;
  deadLettered: number;
  /** Rows whose claim was lost before dispatch/completion (rescued by another poller). */
  lostClaim: number;
  /** Dispatched but the completion write failed — will be re-dispatched after the stale window. */
  completionUnrecorded: number;
}

/** The TransactionEvent an outbox row is published as. `id` is the outbox row id (stable idempotency key). */
export function outboxRowToTransactionEvent(row: ClaimedOutboxEvent): TransactionEvent {
  const payload = (row.payload ?? {}) as Record<string, any>;
  return {
    id: row.id,
    timestamp: row.createdAt?.toISOString?.() || new Date().toISOString(),
    appId: row.appId,
    // Phase 7: the tenant the producer recorded (server-derived, see
    // paymentWebhook.ts); absent → the event is dispatched to no tenant.
    ...(typeof payload.tenantId === 'string' && payload.tenantId ? { tenantId: payload.tenantId } : {}),
    category: payload.category || 'payment',
    providerId: payload.providerId,
    status: payload.status || 'success',
    latency: 0,
    cost: 0,
    decisionReason: row.eventType,
    payload: payload.payload || payload,
    response: payload.response || null,
  } as TransactionEvent;
}

/**
 * Default dispatcher: publish on the EventBus with emitOrThrow(), which —
 * unlike emit() — throws when the Redis publish fails, so a Redis outage
 * leaves the row to be retried instead of marking it delivered.
 */
export function eventBusOutboxDispatcher(eventBus: EventBus): OutboxDispatcher {
  return async (row) => {
    const event = outboxRowToTransactionEvent(row);
    const strict = (eventBus as EventBus & { emitOrThrow?: (e: TransactionEvent) => Promise<void> }).emitOrThrow;
    if (typeof strict === 'function') {
      await strict.call(eventBus, event);
    } else {
      await eventBus.emit(event);
    }
  };
}

class OutboxDispatchTimeoutError extends Error {
  constructor(ms: number) {
    super(`outbox dispatch timed out after ${ms}ms`);
    this.name = 'OutboxDispatchTimeoutError';
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OutboxDispatchTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const errText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** One poll of the outbox. Exported so tests (and an operator script) can drive it directly. */
export async function runOutboxPollOnce(
  store: OutboxStore,
  dispatch: OutboxDispatcher,
  cfgIn: Partial<OutboxConsumerConfig> = {},
): Promise<OutboxPollResult> {
  const cfg = { ...DEFAULT_OUTBOX_CONSUMER_CONFIG, ...cfgIn };
  const policy = { maxAttempts: cfg.maxAttempts, baseDelayMs: cfg.baseDelayMs, maxDelayMs: cfg.maxDelayMs };
  // A dispatch must always finish (or be abandoned) well inside the stale
  // window, or a slow-but-alive owner could be rescued mid-dispatch.
  const dispatchTimeoutMs = Math.max(1, Math.min(cfg.dispatchTimeoutMs, Math.floor(cfg.staleAfterMs / 2)));
  const result: OutboxPollResult = {
    rescued: 0,
    rescuedToDead: 0,
    claimed: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
    lostClaim: 0,
    completionUnrecorded: 0,
  };

  try {
    const rescue = await store.rescueStale({
      staleAfterMs: cfg.staleAfterMs,
      maxAttempts: cfg.maxAttempts,
      limit: cfg.rescueLimit,
    });
    result.rescued = rescue.requeued.length;
    result.rescuedToDead = rescue.deadLettered.length;
    if (rescue.requeued.length > 0) {
      logger.warn('requeued outbox events whose claim went stale', {
        operation: 'outbox_poller',
        status: 'rescued',
        requeued: rescue.requeued.length,
      });
    }
    for (const dead of rescue.deadLettered) {
      logger.error('outbox event dead-lettered', {
        operation: 'outbox_poller',
        errorCode: 'OUTBOX_DEAD_LETTERED',
        status: 'dead',
        outboxEventId: dead.id,
        eventType: dead.eventType,
        attempts: dead.attempts,
        error: dead.error,
      });
    }
  } catch (err) {
    // Not fatal: stale rows stay `processing` and are rescued next poll.
    logger.error('outbox stale-claim rescue failed', {
      operation: 'outbox_poller',
      errorCode: 'OUTBOX_RESCUE_FAILED',
      status: 'failed',
      error: err,
    });
  }

  // A failure here throws out of the poll; nothing was claimed, so nothing is lost.
  const rows = await store.claimBatch(cfg.batchSize);
  result.claimed = rows.length;

  for (const row of rows) {
    let owned = false;
    try {
      owned = await store.renewClaim(row.id, row.claimToken);
    } catch (err) {
      // Unknown whether we still own it; don't dispatch. If we do, the claim
      // goes stale and the row is rescued.
      logger.error('could not renew claim on outbox event — not dispatching', {
        operation: 'outbox_poller',
        errorCode: 'OUTBOX_CLAIM_RENEW_FAILED',
        status: 'failed',
        outboxEventId: row.id,
        error: err,
      });
      continue;
    }
    if (!owned) {
      result.lostClaim++;
      continue;
    }

    try {
      await withTimeout(dispatch(row), dispatchTimeoutMs);
    } catch (err) {
      try {
        const next = await store.fail(row.id, row.claimToken, errText(err), policy);
        if (next === 'dead') {
          result.deadLettered++;
          logger.error('outbox event dead-lettered', {
            operation: 'outbox_poller',
            errorCode: 'OUTBOX_DEAD_LETTERED',
            status: 'dead',
            outboxEventId: row.id,
            eventType: row.eventType,
            attempts: row.attempts,
            error: err,
          });
        } else if (next === 'pending') {
          result.retried++;
          logger.warn('outbox event dispatch failed — will retry', {
            operation: 'outbox_poller',
            errorCode: 'OUTBOX_DISPATCH_FAILED',
            status: 'retrying',
            outboxEventId: row.id,
            eventType: row.eventType,
            attempts: row.attempts,
            error: err,
          });
        } else {
          result.lostClaim++;
        }
      } catch (failErr) {
        // Row stays `processing`; the stale-claim rescue returns it to pending.
        logger.error('could not record outbox dispatch failure — the stale-claim rescue will return it to pending', {
          operation: 'outbox_poller',
          errorCode: 'OUTBOX_FAIL_UNRECORDED',
          status: 'failed',
          outboxEventId: row.id,
          error: failErr,
        });
      }
      continue;
    }

    try {
      if (await store.complete(row.id, row.claimToken)) {
        result.completed++;
      } else {
        // Our claim lapsed during dispatch and someone else may re-dispatch:
        // the downstream must de-duplicate on the event id (= row id).
        result.lostClaim++;
        logger.warn('dispatched outbox event but its claim had been lost — downstream may see it again (same id)', {
          operation: 'outbox_poller',
          errorCode: 'OUTBOX_CLAIM_LOST',
          status: 'lost_claim',
          outboxEventId: row.id,
        });
      }
    } catch (err) {
      result.completionUnrecorded++;
      logger.error('dispatched outbox event but could not record completion — it will be re-dispatched (same id) after the stale window', {
        operation: 'outbox_poller',
        errorCode: 'OUTBOX_COMPLETION_UNRECORDED',
        status: 'failed',
        outboxEventId: row.id,
        error: err,
      });
    }
  }
  return result;
}

export function createOutboxPollerProcessor(deps: JobDeps): JobProcessor {
  return async () => {
    const store = deps.outbox ?? outboxEventRepository;
    const dispatch = deps.outboxDispatch ?? eventBusOutboxDispatcher(deps.eventBus);
    await runOutboxPollOnce(store, dispatch, resolveOutboxConsumerConfig(deps.config.outbox));
  };
}
