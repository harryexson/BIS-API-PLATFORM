import { logger } from '@company/observability';
import { createHmac, timingSafeEqual } from 'crypto';
import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { transactionStatusesAllowedInto, webhookEventRepository } from '@company/database';
import { ProviderWebhookEvent } from '@company/schemas';
import { runDurableWebhookConsumer, type WebhookEventStore } from '../webhookEvents';

function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // P1-5 FIX: Use hex encoding for both buffers to match the gateway's comparison.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The transactions-row change a (Stripe-shaped) payment webhook implies.
 *
 * Phase 6 (D4/D11):
 *  - The row is matched on the provider id the PLATFORM stored, which for
 *    Stripe is the PaymentIntent id (pi_...). A `charge.*` event's
 *    data.object is a Charge (ch_...) whose `payment_intent` field carries
 *    that id, so it is preferred over data.object.id.
 *  - `metadata.bisPaymentTransactionId` (set by the Stripe adapter on every
 *    real PaymentIntent) is passed through so an ambiguous row whose provider
 *    id was never received (router timeout) can still be matched — see
 *    webhookEventRepository.persistEffectsOnce.
 *  - `charge.refunded` with `refunded: false` (Stripe sets `refunded` only
 *    once the charge is FULLY refunded) is a partial refund.
 *  - PaymentIntent lifecycle events map onto the state machine too.
 * Whether the change is actually applied is decided by Postgres against the
 * row's current status (VALID_TRANSITIONS), never here.
 */
export function paymentWebhookTransactionTarget(
  eventType: string | undefined,
  object: any,
  providerEventId?: string,
): { providerTransactionId: string | undefined; toStatus: string | null; paymentTransactionId: string | null } {
  const piRef = typeof object?.payment_intent === 'string' ? object.payment_intent : undefined;
  const providerTransactionId = piRef || object?.id || providerEventId;
  const toStatus =
    eventType === 'charge.succeeded' || eventType === 'payment_intent.succeeded' ? 'success'
    : eventType === 'charge.failed' || eventType === 'payment_intent.payment_failed' ? 'failed'
    : eventType === 'charge.refunded' ? (object?.refunded === false ? 'partially_refunded' : 'refunded')
    : eventType === 'charge.pending' || eventType === 'payment_intent.processing' ? 'pending'
    : eventType === 'payment_intent.requires_action' ? 'requires_action'
    : eventType === 'payment_intent.canceled' ? 'cancelled'
    : null;
  const bis = object?.metadata?.bisPaymentTransactionId;
  return {
    providerTransactionId: providerTransactionId ? String(providerTransactionId) : undefined,
    toStatus,
    paymentTransactionId: typeof bis === 'string' && bis ? bis : null,
  };
}

export function createPaymentWebhookProcessor(deps: JobDeps): JobProcessor {
  return async (job) => {
    const payload = job.payload as Partial<ProviderWebhookEvent> & { webhookEventId?: string; tenantId?: string; type?: string };
    const { provider, rawBody, signature, providerEventId } = payload;

    if (!provider) {
      throw new Error('payment_webhook requires provider');
    }

    // Phase 4 (gap register B5): durable identity is (provider, providerEventId).
    // A job without one cannot be de-duplicated, so it is rejected rather
    // than processed blindly.
    const eventId = providerEventId || job.payload.id;
    if (!eventId) {
      throw new Error('payment_webhook requires providerEventId (durable webhook identity)');
    }

    const secret = process.env.WEBHOOK_HMAC_SECRET;
    if (secret) {
      if (!signature || !rawBody) {
        throw new Error('payment_webhook signature required');
      }
      if (!verifySignature(secret, rawBody, signature)) {
        throw new Error('payment_webhook signature verification failed');
      }
    } else {
      // P0: FAIL CLOSED — reject webhooks when HMAC secret is not configured.
      // Processing unverified webhooks is a security vulnerability.
      logger.error('rejecting webhook — WEBHOOK_HMAC_SECRET not configured, cannot verify authenticity', {
        operation: 'payment_webhook',
        errorCode: 'WEBHOOK_HMAC_NOT_CONFIGURED',
        status: 'rejected',
      });
      throw new Error('payment_webhook rejected: WEBHOOK_HMAC_SECRET not configured — cannot verify webhook authenticity');
    }

    // B5 FIX: the old code set a Redis/memory `setNx` replay marker HERE,
    // before doing any work, and never cleared it — so the first transient
    // failure (DB error, lock contention) turned every retry into a
    // permanent "Replay detected" and the webhook was lost. Completion state
    // now lives in Postgres (webhook_event_consumers): a failed attempt is
    // recorded as `failed` and cleanly re-claimed by the retry; only a
    // consumer row already `processed` is a genuine replay, which completes
    // as a no-op instead of dead-lettering.
    const store = deps.webhookEvents ?? webhookEventRepository;
    await runDurableWebhookConsumer(
      store,
      'payment_webhook',
      {
        webhookEventId: payload.webhookEventId,
        providerId: provider,
        providerEventId: String(eventId),
        fallbackRow: () => {
          let body: unknown = {};
          try {
            body = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            body = {};
          }
          return {
            appId: payload.applicationId ?? null,
            tenantId: payload.tenantId ?? null,
            eventType: payload.type ?? payload.eventType ?? null,
            payload: body,
            rawBody: rawBody ?? '',
            signature: signature ?? null,
          };
        },
      },
      (event) => processPaymentWebhook(job, deps, store, event.id, provider, String(eventId)),
      { leaseMs: deps.config.webhookConsumerLeaseMs },
    );
  };
}

async function processPaymentWebhook(
  job: Parameters<JobProcessor>[0],
  deps: JobDeps,
  store: WebhookEventStore,
  webhookEventId: string,
  provider: string,
  eventId: string,
): Promise<void> {
  const payload = job.payload as Partial<ProviderWebhookEvent> & { tenantId?: string };
  const { providerEventId } = payload;
  const appId = payload.applicationId || 'webhook';
  // Phase 7 (gap register C4): the tenant comes from the durable
  // webhook_events row, which the gateway attributed from the platform's own
  // transactions row (never from the provider payload's metadata — GW-1.1).
  // Absent when the webhook could not be attributed; such an event is then
  // never dispatched to any tenant's outbound webhook endpoint.
  const tenantId = typeof payload.tenantId === 'string' && payload.tenantId ? payload.tenantId : undefined;

  // Build clean event record (strip raw webhook data)
  const clean = { ...job.payload };
  delete (clean as any).rawBody;
  delete (clean as any).signature;

  // P0 FIX: Normalize webhook type → eventType.
  // Stripe webhooks use `type` (e.g., "charge.succeeded") but the
  // ProviderWebhookEvent schema defines `eventType`. The receipt pipeline
  // consumes `eventType`, so we must propagate it correctly.
  if (clean.type && !clean.eventType) {
    clean.eventType = clean.type;
  }

  // The business-state change this webhook implies (transaction status).
  const target = paymentWebhookTransactionTarget(clean.eventType, clean.data?.object, providerEventId);
  const providerTxId = target.providerTransactionId;
  const newStatus = target.toStatus;

  // Event row + outbox row + transaction status change, written atomically
  // (ONE SQL statement — no db.transaction(), which neon-http cannot run:
  // gap register D1) and AT MOST ONCE per durable webhook event, so a retry
  // after a later failure (e.g. the emit below) does not record this
  // webhook — or re-apply its state change — twice.
  //
  // Phase 5: the transaction status update used to run here as a SEPARATE,
  // best-effort statement after the events/outbox write, with its errors
  // swallowed — a DB failure there lost the state change silently while the
  // outbox still announced the event. It is now part of the same statement,
  // and its transition guard (VALID_TRANSITIONS) is evaluated by Postgres on
  // the row's current status.
  let persisted: { inserted: boolean; transactionUpdated: boolean };
  try {
    persisted = await store.persistEffectsOnce({
      idempotencyKey: `webhook:${webhookEventId}:payment_webhook`,
      event: {
        appId,
        tenantId: tenantId ?? null,
        category: 'payment_webhook',
        providerId: provider,
        status: payload.status || 'success',
        decisionReason: 'payment_webhook_received',
        payload: clean,
        response: clean.data ?? null,
      },
      outbox: {
        appId,
        eventType: 'payment_webhook_received',
        payload: {
          id: eventId,
          timestamp: payload.timestamp || new Date().toISOString(),
          appId,
          ...(tenantId ? { tenantId } : {}),
          category: 'payment',
          providerId: provider,
          status: payload.status || 'success',
          decisionReason: 'payment_webhook_received',
          payload: clean,
          response: clean.data ?? null,
        },
      },
      transactionStatus:
        providerTxId && newStatus
          ? {
              providerTransactionId: String(providerTxId),
              toStatus: newStatus,
              allowedFrom: transactionStatusesAllowedInto(newStatus),
              paymentTransactionId: target.paymentTransactionId,
            }
          : undefined,
    });
  } catch (err) {
    logger.error('payment webhook database write failed — failing job for retry', {
      operation: 'payment_webhook',
      errorCode: 'DB_WRITE_FAILED',
      status: 'failed',
      error: err,
    });
    throw new Error('payment_webhook: database write failed — retrying');
  }
  if (persisted.inserted && newStatus && providerTxId && !persisted.transactionUpdated) {
    // Not an error: no transaction carries this provider id yet, or the
    // transition is not allowed from its current status (e.g. a late
    // 'succeeded' after 'refunded').
    logger.warn('payment webhook did not move a transaction (absent or transition not allowed)', {
      operation: 'payment_webhook',
      status: 'not_applied',
      providerTransactionId: String(providerTxId),
      toStatus: newStatus,
    });
  }

  // Emit normalized event to EventBus for downstream pipeline (receipt, outbox, etc.)
  await deps.eventBus.emit({
    id: eventId,
    timestamp: payload.timestamp || new Date().toISOString(),
    appId,
    ...(tenantId ? { tenantId } : {}),
    category: 'payment',
    providerId: provider,
    status: payload.status || 'success',
    latency: 0,
    cost: 0,
    decisionReason: 'payment_webhook_received',
    payload: clean,
    response: clean.data ?? null,
  });
}
