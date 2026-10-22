import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';
import { channelDecisionColumns, isMessageChannel } from '@company/routing';

/**
 * P0: Keyword response delivery processor.
 *
 * When a keyword handler (STOP, START, HELP, YES, NO, or an owner-configured
 * command with reply text) generates a response, this processor sends it
 * back to the customer via the messaging provider, scoped to the owner
 * (app, tenant, supplier) the inbound message was attributed to.
 *
 * Phase 9: the inbound worker now actually ENQUEUES this job (before, the
 * processor was registered but nothing ever enqueued it, so no keyword reply
 * — not even the HELP reply — ever reached a customer).
 *
 * Consent:
 *  - the confirmation of a STOP ('opt_out') is the one message allowed after
 *    an opt-out, so it is sent with routeMessage's internal
 *    optOutConfirmation option (never reachable from a request body);
 *  - any other reply to a recipient who is opted out (tenant- or
 *    number-level) is refused by the router with ConsentBlockedError — that
 *    is final, not a transient failure, so it is recorded and NOT retried.
 */
export function createKeywordResponseDeliveryProcessor(deps: JobDeps): JobProcessor {
  return async (job, _ctx: WorkerContext) => {
    const { senderPhone, content, appId, providerId, tenantId, supplierId, keyword, keywordName, conversationId } = job.payload;
    // Phase 10 (gap register A6): a reply goes back on the channel the
    // inbound message ARRIVED on — an explicit channel, never re-guessed from
    // the reply's wording (a long HELP reply used to be inferred as
    // WhatsApp). Jobs enqueued before this field existed fall back to the
    // router's inferred default.
    const channel = isMessageChannel(job.payload.channel) ? job.payload.channel : undefined;

    if (!senderPhone || !content) {
      throw new Error('keyword_response_delivery requires senderPhone and content');
    }

    const scope = {
      tenantId: tenantId || 'default',
      ...(typeof supplierId === 'string' && supplierId ? { supplierId } : {}),
    };

    let event;
    try {
      event = await deps.routing.routeMessage(
        appId,
        {
          recipient: senderPhone,
          content,
          providerOverride: providerId,
          ...(channel ? { channel } : {}),
          ...scope,
        },
        keyword === 'opt_out' ? { optOutConfirmation: true } : {},
      );
    } catch (err: any) {
      if (err?.name === 'ConsentBlockedError') {
        console.warn(`[keyword_response_delivery] reply to ${senderPhone} not sent: recipient is opted out (${keywordName || keyword})`);
        try {
          await eventRepository.create({
            appId,
            ...(tenantId ? { tenantId } : {}),
            category: 'messaging',
            providerId: providerId ?? null,
            status: 'failed',
            decisionReason: `keyword_response_suppressed:${keyword || 'unknown'}`,
            payload: { recipient: senderPhone, keyword: keywordName ?? keyword, conversationId, ...scope },
            error: err.message,
            ...(channel ? { requestedChannel: channel } : {}),
          });
        } catch {
          // audit is best-effort here; the send was (correctly) not made
        }
        return;
      }
      console.error('[keyword_response_delivery] Failed to send response', err);
      throw new Error('keyword_response_delivery: send failed — retrying');
    }

    // Persist the response delivery event. The message is already SENT: a
    // failed audit write must not fail the job, or the retry would send the
    // customer the same reply twice.
    try {
      await eventRepository.create({
        appId,
        // Phase 16: the conversation's tenant in the column (D14/D16).
        ...(tenantId ? { tenantId } : {}),
        category: 'messaging',
        providerId: event.providerId,
        status: event.status,
        latency: event.latency,
        cost: String(event.cost),
        decisionReason: `keyword_response:${keyword || 'unknown'}`,
        payload: { ...(event.payload ?? {}), keyword: keywordName ?? keyword, conversationId, ...scope },
        response: event.response,
        error: event.error,
        ...channelDecisionColumns(event),
      });
    } catch (err) {
      console.error('[keyword_response_delivery] reply sent but its audit event could not be written', err);
    }

    // Emit for monitoring (Phase 7: scoped to the conversation's tenant)
    await deps.eventBus.emit({ ...event, ...scope });
  };
}
