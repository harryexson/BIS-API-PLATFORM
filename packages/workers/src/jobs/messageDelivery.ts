import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';
import { channelDecisionColumns } from '@company/routing';

export function createMessageDeliveryProcessor(deps: JobDeps): JobProcessor {
  return async (job) => {
    const { appId, recipient, content, providerOverride, tenantId, channel, channelPolicy } = job.payload;

    if (!appId || !recipient || !content) {
      throw new Error('message_delivery requires appId, recipient and content');
    }

    const rate = await deps.rateLimiter.limit(`message:${appId}`, 1);
    if (!rate.allowed) {
      throw new Error(`Rate limit exceeded for app "${appId}" (reset in ${rate.resetMs}ms)`);
    }

    // P0 FIX: Pass tenantId to routing engine for conversation isolation
    const routed = await deps.routing.routeMessage(appId, {
      recipient,
      content,
      providerOverride,
      // Phase 10: an explicitly requested channel (and opt-in channel-switch
      // policy) is forwarded; absent = the router's inferred default.
      ...(channel ? { channel } : {}),
      ...(channelPolicy ? { channelPolicy } : {}),
      tenantId: tenantId || 'default',
    });
    // Phase 7: carry the job's tenant onto the event (it scopes outbound
    // webhook dispatch); an untenanted job's event reaches no tenant.
    const event = tenantId ? { ...routed, tenantId } : routed;

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
        ...channelDecisionColumns(event),
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
