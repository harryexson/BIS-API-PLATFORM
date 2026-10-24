import { logger } from '@company/observability';
import type {
  WebhookEvent,
  WebhookEventClaimInput,
  WebhookEventRepository,
} from '@company/database';
import type { JobPayload, JobType } from './types';

/**
 * Phase 4 — durable inbound-webhook pipeline, shared by the gateway (ingest)
 * and the worker (consume + recover). Provider-agnostic: nothing here knows
 * about any specific payment or messaging provider.
 *
 * The source of truth for "have we seen this webhook?" and "has it been
 * processed?" is the `webhook_events` / `webhook_event_consumers` tables
 * (packages/database/src/schema/webhook-events.ts), whose uniqueness is
 * enforced by Postgres. No in-memory map and no Redis key is consulted for
 * correctness anywhere in this file.
 */

/** Job types that record durable per-consumer completion in webhook_event_consumers. */
export const WEBHOOK_CONSUMERS = ['payment_webhook', 'provider_webhook'] as const;

/** Every job the gateway enqueues for one accepted webhook, in enqueue order. */
export const WEBHOOK_JOB_TYPES: readonly JobType[] = ['inbound_message', 'payment_webhook', 'provider_webhook'];

export const DEFAULT_WEBHOOK_ENQUEUE_LEASE_MS = 30_000;
export const DEFAULT_WEBHOOK_CONSUMER_LEASE_MS = 5 * 60_000;
export const DEFAULT_WEBHOOK_STALE_ENQUEUE_MS = 10 * 60_000;

/** The subset of the repository this module needs (lets tests bind a real-Postgres instance). */
export type WebhookEventStore = Pick<
  WebhookEventRepository,
  | 'claim'
  | 'findById'
  | 'findByProviderEvent'
  | 'acquireEnqueueLease'
  | 'markEnqueued'
  | 'releaseEnqueueLease'
  | 'claimStrandedForEnqueue'
  | 'claimConsumer'
  | 'completeConsumer'
  | 'failConsumer'
  | 'persistEffectsOnce'
>;

export type EnqueueFn = (type: JobType, payload: JobPayload) => Promise<unknown>;

/**
 * The job payloads for one durable webhook row. Shapes are exactly what the
 * gateway has always enqueued (so existing processors are unchanged), plus
 * `webhookEventId` linking each job back to its durable row.
 */
export function buildWebhookJobs(event: WebhookEvent): Array<{ type: JobType; payload: JobPayload }> {
  const body = (event.payload ?? {}) as Record<string, unknown>;
  return [
    {
      type: 'inbound_message',
      payload: { providerId: event.providerId, payload: body, webhookEventId: event.id },
    },
    {
      type: 'payment_webhook',
      payload: {
        provider: event.providerId,
        rawBody: event.rawBody,
        signature: event.signature ?? '',
        providerEventId: event.providerEventId,
        applicationId: event.appId || 'webhook',
        tenantId: event.tenantId ?? undefined,
        webhookEventId: event.id,
      },
    },
    {
      type: 'provider_webhook',
      payload: {
        providerId: event.providerId,
        rawBody: event.rawBody,
        signature: event.signature ?? '',
        eventId: event.providerEventId,
        status: event.eventType ?? undefined,
        webhookEventId: event.id,
      },
    },
  ];
}

/**
 * Enqueue whichever of this event's jobs are not already recorded in
 * `enqueued_jobs`, then record the enqueue. The caller MUST hold the
 * event's enqueue lease. On failure the lease is released immediately (with
 * the jobs that did make it), so a provider retry or the recovery sweeper
 * can finish the job without re-enqueueing what already went out.
 */
export async function enqueueWebhookEventJobs(
  store: WebhookEventStore,
  enqueue: EnqueueFn,
  event: WebhookEvent,
  opts: { only?: readonly JobType[] } = {},
): Promise<{ ok: true; jobs: string[] } | { ok: false; jobs: string[]; error: Error }> {
  const done = new Set<string>(event.enqueuedJobs ?? []);
  const wanted = buildWebhookJobs(event).filter((j) => !opts.only || opts.only.includes(j.type));
  for (const job of wanted) {
    if (done.has(job.type) && !opts.only) continue;
    try {
      await enqueue(job.type, job.payload);
      done.add(job.type);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await store
        .releaseEnqueueLease(event.id, [...done], `enqueue ${job.type} failed: ${error.message}`)
        .catch(() => undefined); // the lease also simply expires
      return { ok: false, jobs: [...done], error };
    }
  }
  await store.markEnqueued(event.id, [...done]);
  return { ok: true, jobs: [...done] };
}

// ---------------------------------------------------------------------------
// Gateway side: persist → enforce uniqueness → enqueue → (caller) acknowledge
// ---------------------------------------------------------------------------

export interface WebhookIngestInput {
  providerId: string;
  providerEventId: string;
  appId?: string | null;
  tenantId?: string | null;
  eventType?: string | null;
  payload: unknown;
  rawBody: string;
  signature?: string | null;
}

export type WebhookIngestOutcome =
  /** First durable sighting; persisted and every job enqueued. Acknowledge (200). */
  | { kind: 'accepted'; event: WebhookEvent; jobs: string[] }
  /** Already durably recorded and enqueued by an earlier delivery. Acknowledge (200), enqueue nothing. */
  | { kind: 'duplicate'; event: WebhookEvent }
  /** Duplicate of an event whose earlier enqueue never completed; this delivery finished it. Acknowledge (200). */
  | { kind: 'recovered'; event: WebhookEvent; jobs: string[] }
  /** Duplicate of an event another request is enqueueing right now. Do NOT acknowledge (503) — retry later. */
  | { kind: 'in_flight'; event: WebhookEvent }
  /** The durable write itself failed. Do NOT acknowledge (5xx) — the provider must retry. */
  | { kind: 'persist_failed'; error: Error }
  /** Persisted, but the enqueue failed; lease released for the retry. Do NOT acknowledge (503). */
  | { kind: 'enqueue_failed'; event: WebhookEvent; error: Error };

export function isAcknowledged(outcome: WebhookIngestOutcome): boolean {
  return outcome.kind === 'accepted' || outcome.kind === 'duplicate' || outcome.kind === 'recovered';
}

/**
 * Steps 7-9 of the webhook pipeline (persist durably, enforce uniqueness,
 * enqueue). The caller has already done receive / verify / validate /
 * identify, and acknowledges only when isAcknowledged(outcome).
 */
export async function ingestWebhook(
  deps: { store: WebhookEventStore; enqueue: EnqueueFn; enqueueLeaseMs?: number },
  input: WebhookIngestInput,
): Promise<WebhookIngestOutcome> {
  const leaseMs = deps.enqueueLeaseMs ?? DEFAULT_WEBHOOK_ENQUEUE_LEASE_MS;

  let claim;
  try {
    claim = await deps.store.claim({
      providerId: input.providerId,
      providerEventId: input.providerEventId,
      appId: input.appId ?? null,
      tenantId: input.tenantId ?? null,
      eventType: input.eventType ?? null,
      payload: input.payload,
      rawBody: input.rawBody,
      signature: input.signature ?? null,
      expectedConsumers: [...WEBHOOK_CONSUMERS],
      enqueueLeaseMs: leaseMs,
    });
  } catch (err) {
    return { kind: 'persist_failed', error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (claim.claimed) {
    const result = await enqueueWebhookEventJobs(deps.store, deps.enqueue, claim.event).catch(
      (err: unknown) => ({ ok: false as const, jobs: [] as string[], error: err instanceof Error ? err : new Error(String(err)) }),
    );
    return result.ok
      ? { kind: 'accepted', event: claim.event, jobs: result.jobs }
      : { kind: 'enqueue_failed', event: claim.event, error: result.error };
  }

  const existing = claim.existing;
  if (!existing) {
    // The unique index rejected the insert but the row cannot be read back.
    return { kind: 'persist_failed', error: new Error('webhook_events conflict but existing row not readable') };
  }
  if (existing.enqueuedAt) {
    return { kind: 'duplicate', event: existing };
  }

  // Durably recorded but never (fully) enqueued — e.g. the first delivery's
  // enqueue failed and it answered 503, or its gateway died mid-request.
  // Take the enqueue over if (and only if) nobody holds a live lease.
  let leased: WebhookEvent | undefined;
  try {
    leased = await deps.store.acquireEnqueueLease(existing.id, leaseMs);
  } catch (err) {
    return { kind: 'persist_failed', error: err instanceof Error ? err : new Error(String(err)) };
  }
  if (!leased) {
    const now = await deps.store.findById(existing.id).catch(() => undefined);
    if (now?.enqueuedAt) return { kind: 'duplicate', event: now };
    return { kind: 'in_flight', event: now ?? existing };
  }
  const result = await enqueueWebhookEventJobs(deps.store, deps.enqueue, leased).catch(
    (err: unknown) => ({ ok: false as const, jobs: [] as string[], error: err instanceof Error ? err : new Error(String(err)) }),
  );
  return result.ok
    ? { kind: 'recovered', event: leased, jobs: result.jobs }
    : { kind: 'enqueue_failed', event: leased, error: result.error };
}

// ---------------------------------------------------------------------------
// Worker side: durable per-consumer processing (replaces the B5 setNx marker)
// ---------------------------------------------------------------------------

/** Another worker holds a live claim on this consumer. Retryable. */
export class WebhookConsumerBusyError extends Error {
  constructor(public readonly webhookEventId: string, public readonly consumer: string) {
    super(`webhook event ${webhookEventId} is being processed by another worker (${consumer}) — will retry`);
    this.name = 'WebhookConsumerBusyError';
  }
}

export interface DurableConsumerIdentity {
  /** Durable row id carried by jobs the gateway enqueued (preferred). */
  webhookEventId?: string;
  providerId: string;
  providerEventId: string;
  /**
   * Used only when no durable row exists yet for this identity (a job
   * enqueued by something other than the Phase-4 gateway, e.g. a job queued
   * before this deploy): the row is created with the same atomic claim the
   * gateway uses, so identity is still DB-enforced.
   */
  fallbackRow: () => Omit<WebhookEventClaimInput, 'providerId' | 'providerEventId' | 'expectedConsumers' | 'enqueueLeaseMs'>;
}

export type DurableConsumerResult =
  | { outcome: 'processed'; webhookEventId: string }
  /** Genuine replay: this consumer already finished for this event. Nothing was done. */
  | { outcome: 'replay'; webhookEventId: string };

export async function runDurableWebhookConsumer(
  store: WebhookEventStore,
  consumer: string,
  identity: DurableConsumerIdentity,
  work: (event: WebhookEvent) => Promise<void>,
  opts: { leaseMs?: number; log?: (message: string, fields: Record<string, unknown>) => void } = {},
): Promise<DurableConsumerResult> {
  const leaseMs = opts.leaseMs ?? DEFAULT_WEBHOOK_CONSUMER_LEASE_MS;
  const log = opts.log ?? ((message: string, fields: Record<string, unknown>) => logger.warn(message, fields));

  // 1. Resolve the durable row (DB errors propagate → job retries).
  let event: WebhookEvent | undefined;
  if (identity.webhookEventId) event = await store.findById(identity.webhookEventId);
  if (!event) event = await store.findByProviderEvent(identity.providerId, identity.providerEventId);
  if (!event) {
    const claim = await store.claim({
      ...identity.fallbackRow(),
      providerId: identity.providerId,
      providerEventId: identity.providerEventId,
      expectedConsumers: [consumer],
      enqueueLeaseMs: DEFAULT_WEBHOOK_ENQUEUE_LEASE_MS,
    });
    if (claim.claimed) {
      // This job IS the enqueue of the row it just created; record that so
      // the recovery sweeper does not enqueue it a second time.
      await store.markEnqueued(claim.event.id, [consumer]);
      event = claim.event;
    } else {
      event = claim.existing;
    }
  }
  if (!event) {
    throw new Error(`webhook event ${identity.providerId}/${identity.providerEventId} could not be resolved`);
  }

  // 2. Claim this consumer (single atomic statement).
  const claim = await store.claimConsumer(event.id, consumer, leaseMs);
  if (!claim.claimed) {
    if (claim.existing?.status === 'processed') {
      log('webhook already processed — replay ignored', {
        operation: consumer,
        providerId: identity.providerId,
        providerEventId: identity.providerEventId,
        webhookEventId: event.id,
        status: 'replay',
      });
      return { outcome: 'replay', webhookEventId: event.id };
    }
    throw new WebhookConsumerBusyError(event.id, consumer);
  }

  // 3. Do the work; record the outcome under our claim token.
  try {
    await work(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.failConsumer(event.id, consumer, claim.consumer.claimToken, message).catch((e: unknown) => {
      // If even this write fails, the lease simply expires and a retry re-claims.
      log('could not record webhook consumer failure — the lease will expire and a retry re-claims', {
        operation: consumer,
        webhookEventId: event!.id,
        errorCode: 'WEBHOOK_CONSUMER_FAIL_UNRECORDED',
        status: 'failed',
        error: e,
      });
    });
    throw err;
  }
  const completed = await store.completeConsumer(event.id, consumer, claim.consumer.claimToken);
  if (!completed) {
    log('lost claim on webhook before completion (lease expired and another worker took over)', {
      operation: consumer,
      webhookEventId: event.id,
      errorCode: 'WEBHOOK_CONSUMER_CLAIM_LOST',
      status: 'lost_claim',
    });
  }
  return { outcome: 'processed', webhookEventId: event.id };
}

// ---------------------------------------------------------------------------
// Worker side: recovery sweeper
// ---------------------------------------------------------------------------

/**
 * Re-enqueue durable webhook rows that never made it into (or got lost
 * from) the queue. This is what makes a persisted webhook survive a Redis
 * outage, a gateway that fell back to an in-memory store, or a gateway
 * crash between persist and enqueue — independent of any provider retry.
 * Safe to run concurrently: rows are leased with FOR UPDATE SKIP LOCKED, and
 * the consumers themselves are idempotent via webhook_event_consumers.
 */
export async function recoverStrandedWebhookEvents(
  store: WebhookEventStore,
  enqueue: EnqueueFn,
  opts: { limit?: number; leaseMs?: number; staleAfterMs?: number } = {},
): Promise<{ recovered: number; failed: number }> {
  const rows = await store.claimStrandedForEnqueue({
    consumers: [...WEBHOOK_CONSUMERS],
    limit: opts.limit ?? 50,
    leaseMs: opts.leaseMs ?? DEFAULT_WEBHOOK_ENQUEUE_LEASE_MS,
    staleAfterMs: opts.staleAfterMs ?? DEFAULT_WEBHOOK_STALE_ENQUEUE_MS,
  });
  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    // Never enqueued at all → enqueue whatever is missing. Enqueued long ago
    // but no consumer ever started → the queue lost it; re-enqueue only the
    // durable (idempotent) consumers, never re-send inbound_message.
    const result = row.enqueuedAt
      ? await enqueueWebhookEventJobs(store, enqueue, row, { only: WEBHOOK_CONSUMERS })
      : await enqueueWebhookEventJobs(store, enqueue, row);
    if (result.ok) recovered++;
    else failed++;
  }
  return { recovered, failed };
}
