import { JobProcessor, WorkerContext } from '../types';
import { JobDeps } from './deps';
import { eventRepository, conversationRepository } from '@company/database';
import { handleKeyword, ConversationResolver } from '@company/routing';

/**
 * P0: Inbound message processor.
 *
 * The webhook handler persists raw events but never routes them. This processor
 * picks up inbound messages, matches the sender to an existing conversation,
 * and routes the message to the owning app via the EventBus.
 *
 * Flow:
 *   1. Parse provider webhook body → extract sender, content, message type
 *   2. Look up conversations by sender phone + provider to find the owning app
 *   3. Emit routed inbound event via EventBus for the app to consume
 *   4. Persist the inbound event with the resolved appId
 */
export function createInboundMessageProcessor(deps: JobDeps): JobProcessor {
  const resolver = new ConversationResolver();

  return async (job) => {
    const { providerId, payload } = job.payload;

    if (!providerId || !payload) {
      throw new Error('inbound_message requires providerId and payload');
    }

    // --- Step 1: Normalize the inbound message from provider webhook ---
    const inbound = normalizeInboundPayload(providerId, payload);

    if (!inbound.senderPhone) {
      // Cannot route without a sender — discard silently
      console.warn(`[inbound_message] No sender in webhook from ${providerId} — discarding`);
      return;
    }

    // --- Step 2: Deterministic conversation resolution ---
    // P0: Use the ConversationResolver for shared-number disambiguation.
    const resolution = await resolver.resolve(
      inbound.senderPhone,
      providerId,
      inbound.content,
      inbound.recipientPhone,
    );

    if (resolution.confidence === 'none') {
      console.warn(
        `[inbound_message] No active conversation for sender ${inbound.senderPhone} via ${providerId} — discarding`,
      );
      return;
    }

    const conversation = resolution.conversation!;
    const appId = conversation.appId;
    const tenantId = conversation.tenantId;

    // Log ambiguous routing for monitoring
    if (resolution.confidence === 'ambiguous') {
      await deps.eventBus.emit({
        id: `${job.id}_ambiguous`,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId,
        status: 'success',
        latency: 0,
        cost: 0,
        decisionReason: `ambiguous_routing: ${resolution.reason}`,
        payload: { senderPhone: inbound.senderPhone, candidates: resolution.reason },
        response: null,
      });
    }

    // --- Step 3: Check for keyword commands (STOP, HELP, YES, NO, PRAY) ---
    const keywordResult = await handleKeyword({
      senderPhone: inbound.senderPhone,
      appId,
      tenantId,
      content: inbound.content,
      providerId,
    });

    if (keywordResult.handled) {
      // Keyword was handled — log it and emit a response event
      console.log(
        `[inbound_message] Keyword "${inbound.content.trim()}" handled for ${inbound.senderPhone}: ${keywordResult.action}`,
      );

      // Emit keyword response event for the app to send back
      if (keywordResult.response) {
        await deps.eventBus.emit({
          id: `${job.id}_keyword_response`,
          timestamp: new Date().toISOString(),
          appId,
          category: 'messaging',
          providerId,
          status: 'success',
          latency: 0,
          cost: 0,
          decisionReason: `keyword_response:${keywordResult.action}`,
          payload: {
            sender: inbound.senderPhone,
            recipient: inbound.senderPhone, // Reply to the sender
            content: keywordResult.response,
            keyword: keywordResult.action,
            conversationId: conversation.id,
            tenantId,
          },
          response: null,
        });
      }
      return;
    }

    // --- Step 4: Persist the inbound event with the resolved appId ---
    try {
      await eventRepository.create({
        appId,
        category: 'inbound',
        providerId,
        status: 'success',
        decisionReason: `inbound_from_${inbound.senderPhone}`,
        payload: {
          sender: inbound.senderPhone,
          recipient: inbound.recipientPhone,
          content: inbound.content,
          messageType: inbound.messageType,
          conversationId: conversation.id,
          tenantId,
        },
      });
    } catch (err) {
      console.error('[inbound_message] Neon write failed — failing job for retry', err);
      throw new Error('inbound_message: database write failed — retrying');
    }

    // --- Step 5: Emit routed inbound event via EventBus ---
    await deps.eventBus.emit({
      id: job.id,
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging',
      providerId,
      status: 'success',
      latency: 0,
      cost: 0,
      decisionReason: `inbound_routed: ${inbound.senderPhone} → app:${appId} tenant:${tenantId}`,
      payload: {
        sender: inbound.senderPhone,
        recipient: inbound.recipientPhone,
        content: inbound.content,
        messageType: inbound.messageType,
        conversationId: conversation.id,
        tenantId,
      },
      response: null,
    });
  };
}

/**
 * Normalizes various provider webhook formats into a standard inbound message.
 * Different providers (Twilio, Africa's Talking, etc.) send different shapes.
 */
function normalizeInboundPayload(
  providerId: string,
  payload: any,
): {
  senderPhone: string;
  recipientPhone: string;
  content: string;
  messageType: 'message' | 'status_update' | 'delivery_receipt' | 'unknown';
} {
  // Common webhook shapes:
  // Twilio: { From, To, Body, MessageSid, NumMedia }
  // Africa's Talking: { from, to, text, id }
  // Generic: { sender, recipient, content, type }

  const sender =
    payload.From || payload.from || payload.sender || payload.source || '';
  const recipient =
    payload.To || payload.to || payload.recipient || payload.destination || '';
  const content =
    payload.Body || payload.body || payload.text || payload.content || '';
  const rawType =
    payload.type || payload.event || payload.status || 'message';

  // Determine message type
  let messageType: 'message' | 'status_update' | 'delivery_receipt' | 'unknown' = 'message';
  if (typeof rawType === 'string') {
    const lower = rawType.toLowerCase();
    if (lower.includes('status') || lower.includes('update')) {
      messageType = 'status_update';
    } else if (lower.includes('receipt') || lower.includes('delivery') || lower.includes('sent') || lower.includes('delivered') || lower.includes('failed')) {
      messageType = 'delivery_receipt';
    }
  }

  return {
    senderPhone: sender,
    recipientPhone: recipient,
    content,
    messageType,
  };
}
