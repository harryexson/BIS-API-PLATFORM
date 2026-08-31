import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';

/**
 * P0: Production receipt pipeline.
 *
 * Processes payment webhook events and sends receipts for successful charges.
 * Replaces the simulation-only wireReceiptPipeline() with a durable worker.
 *
 * Flow:
 *   1. Receive payment_webhook_received event
 *   2. Filter for charge.succeeded events
 *   3. Extract receipt email from webhook payload
 *   4. Enqueue receipt delivery via message_delivery
 *   5. Emit receipt event for monitoring
 */
export function createReceiptPipelineProcessor(deps: JobDeps): JobProcessor {
  return async (job, ctx: WorkerContext) => {
    const { webhookEvent, appId } = job.payload;

    if (!webhookEvent) {
      throw new Error('receipt_pipeline requires webhookEvent');
    }

    // Only process charge.succeeded events
    const eventType = webhookEvent.eventType || webhookEvent.type;
    if (eventType !== 'charge.succeeded') {
      return;
    }

    const recipient = webhookEvent.data?.object?.receipt_email;
    if (!recipient) {
      console.warn('[receipt_pipeline] No receipt_email in charge.succeeded event — skipping');
      return;
    }

    const amount = webhookEvent.data?.object?.amount || 0;
    const eventAppId = webhookEvent.appId || appId || 'webhook';

    // Send receipt via message delivery
    try {
      const event = await deps.routing.routeMessage(eventAppId, {
        recipient,
        content: `Thank you for your gift of $${Math.round(amount / 100)}.00`,
        providerOverride: undefined,
      });

      // Persist receipt delivery event
      await eventRepository.create({
        appId: eventAppId,
        category: 'messaging',
        providerId: event.providerId,
        status: event.status,
        latency: event.latency,
        cost: String(event.cost),
        decisionReason: 'receipt_sent',
        payload: event.payload,
        response: event.response,
        error: event.error,
      });
    } catch (err) {
      console.error('[receipt_pipeline] Receipt delivery failed', err);
      throw new Error('receipt_pipeline: delivery failed — retrying');
    }

    // Emit receipt event for monitoring
    await deps.eventBus.emit({
      id: `receipt_${job.id}`,
      timestamp: new Date().toISOString(),
      appId: eventAppId,
      category: 'messaging',
      providerId: 'receipt',
      status: 'success',
      latency: 0,
      cost: 0,
      decisionReason: 'receipt_sent',
      payload: { recipient, amount, eventType },
      response: null,
    });
  };
}
