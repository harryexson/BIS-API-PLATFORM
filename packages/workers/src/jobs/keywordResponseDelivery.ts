import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';

/**
 * P0: Keyword response delivery processor.
 *
 * When a keyword handler (STOP, HELP, YES, NO, PRAY) generates a response,
 * this processor sends it back to the user via the messaging provider.
 *
 * Previously, keyword responses were emitted as EventBus events but never
 * actually delivered to the user.
 */
export function createKeywordResponseDeliveryProcessor(deps: JobDeps): JobProcessor {
  return async (job, ctx: WorkerContext) => {
    const { senderPhone, content, appId, providerId, tenantId, keyword } = job.payload;

    if (!senderPhone || !content) {
      throw new Error('keyword_response_delivery requires senderPhone and content');
    }

    // Send the keyword response back to the user
    try {
      const event = await deps.routing.routeMessage(appId, {
        recipient: senderPhone,
        content,
        providerOverride: providerId,
        tenantId: tenantId || 'default',
      });

      // Persist the response delivery event
      await eventRepository.create({
        appId,
        category: 'messaging',
        providerId: event.providerId,
        status: event.status,
        latency: event.latency,
        cost: String(event.cost),
        decisionReason: `keyword_response:${keyword || 'unknown'}`,
        payload: event.payload,
        response: event.response,
        error: event.error,
      });

      // Emit for monitoring
      deps.eventBus.emit(event);
    } catch (err) {
      console.error('[keyword_response_delivery] Failed to send response', err);
      throw new Error('keyword_response_delivery: send failed — retrying');
    }
  };
}
