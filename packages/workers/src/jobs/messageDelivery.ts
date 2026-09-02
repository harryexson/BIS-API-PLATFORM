import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';

export function createMessageDeliveryProcessor(deps: JobDeps): JobProcessor {
  return async (job) => {
    const { appId, recipient, content, providerOverride, tenantId } = job.payload;

    if (!appId || !recipient || !content) {
      throw new Error('message_delivery requires appId, recipient and content');
    }

    const rate = await deps.rateLimiter.limit(`message:${appId}`, 1);
    if (!rate.allowed) {
      throw new Error(`Rate limit exceeded for app "${appId}" (reset in ${rate.resetMs}ms)`);
    }

    // P0 FIX: Pass tenantId to routing engine for conversation isolation
    const event = await deps.routing.routeMessage(appId, {
      recipient,
      content,
      providerOverride,
      tenantId: tenantId || 'default',
    });

    try {
      await eventRepository.create({
        appId: event.appId,
        category: 'messaging',
        providerId: event.providerId,
        status: event.status,
        latency: event.latency,
        cost: String(event.cost),
        decisionReason: event.decisionReason,
        payload: event.payload,
        response: event.response,
        error: event.error,
      });
    } catch (err) {
      // P1: Fail the job on DB error so it can be retried — previously this
      // was silently swallowed and the job was marked complete.
      console.error('[message_delivery] Neon write failed — failing job for retry', err);
      throw new Error('message_delivery: database write failed — retrying');
    }

    await deps.eventBus.emit(event);
  };
}
