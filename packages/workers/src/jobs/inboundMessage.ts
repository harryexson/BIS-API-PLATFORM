import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import {
  eventRepository,
  conversationRepository,
  inboundMessageHoldRepository,
  senderOptOutRepository,
  normalizeMessagingAddress,
  channelFromAddress,
  type InboundHoldCandidate,
} from '@company/database';
import {
  handleKeyword,
  classifyKeyword,
  ConversationResolver,
  type ConversationOwner,
} from '@company/routing';

/**
 * Inbound message processor.
 *
 * Phase 8 (gap register A1-A5) — shared phone numbers. One local number per
 * country is shared by many tenants, so the owner of an inbound message is
 * established ONLY through server-side data (ConversationResolver):
 * provider → destination number → messaging profiles → owners → the
 * customer's conversations on that number.
 *
 *   routed     → exactly one owner. Keyword handling (STOP/YES/NO/...),
 *                persistence and the routed event all happen under THAT
 *                owner (app, tenant, supplier).
 *   ambiguous  → several owners are plausible. NOTHING is delivered to any
 *                tenant: no event row, no keyword handler, no consent change
 *                for any tenant, no tenant-scoped bus event carrying content.
 *                The message is quarantined in inbound_message_holds for an
 *                operator to attribute (admin route), after which it is
 *                delivered to the chosen owner by this same processor.
 *   unroutable → no owner at all. Also quarantined (it used to be a silent
 *                console.warn-and-drop — including for STOP).
 *
 * STOP while ambiguous: recorded at the SHARED-NUMBER level
 * (sender_opt_outs: "this customer must receive nothing from this number"),
 * which is exactly what the carrier itself does with a STOP on a long code,
 * and which applies to every tenant on that number equally — so it can
 * never be "the wrong tenant". No tenant's own consent record is touched
 * until an operator attributes the message. The outbound router refuses to
 * send from that number to that customer meanwhile. See the Phase 8 section
 * of docs/FINAL_PRODUCTION_GAP_REGISTER.md for the full rationale.
 */

/** appId used for platform-level (non-tenant) monitoring events. Never has webhook endpoints. */
export const PLATFORM_EVENT_APP_ID = 'platform';

export interface NormalizedInbound {
  senderPhone: string;
  recipientPhone: string;
  content: string;
  channel: string;
  providerMessageId: string | null;
  messageType: 'message' | 'status_update' | 'delivery_receipt' | 'unknown';
}

export function createInboundMessageProcessor(deps: JobDeps): JobProcessor {
  const resolver = new ConversationResolver();

  /** Deliver a message to the ONE owner it was attributed to (pre-Phase-8 steps 3-5). */
  async function deliverToOwner(args: {
    jobId: string;
    providerId: string;
    owner: ConversationOwner;
    conversationId: string;
    inbound: NormalizedInbound;
    businessNumber: string | null;
    sharedNumber: boolean;
    basis: string;
    holdId?: string;
  }): Promise<void> {
    const { jobId, providerId, owner, conversationId, inbound, businessNumber } = args;
    const { appId, tenantId } = owner;
    const supplierId = owner.supplierId ?? undefined;
    const scope = { tenantId, ...(supplierId ? { supplierId } : {}) };

    // --- Keyword commands (STOP, HELP, YES, NO, PRAY, JOIN) ---
    const keywordResult = await handleKeyword({
      senderPhone: inbound.senderPhone,
      appId,
      tenantId,
      supplierId: owner.supplierId,
      content: inbound.content,
      providerId,
      channel: inbound.channel,
    });

    if (keywordResult.handled) {
      // Gap register A4: on a number shared by several owners the carrier
      // applies STOP/START to the NUMBER. Mirror it so the platform's view
      // of who may send from this number matches the carrier's.
      if (args.sharedNumber && businessNumber && (keywordResult.action === 'opt_out' || keywordResult.action === 'opt_in')) {
        await senderOptOutRepository.upsert({
          businessNumber,
          recipient: inbound.senderPhone,
          channel: inbound.channel,
          status: keywordResult.action === 'opt_out' ? 'opted_out' : 'opted_in',
          source: 'keyword',
          keyword: keywordResult.action === 'opt_out' ? 'STOP' : 'JOIN',
          holdId: args.holdId ?? null,
        });
      }

      console.log(
        `[inbound_message] Keyword "${inbound.content.trim()}" handled for ${inbound.senderPhone}: ${keywordResult.action}`,
      );

      if (keywordResult.response) {
        await deps.eventBus.emit({
          id: `${jobId}_keyword_response`,
          timestamp: new Date().toISOString(),
          appId,
          ...scope,
          category: 'messaging',
          providerId,
          status: 'success',
          latency: 0,
          cost: 0,
          decisionReason: `keyword_response:${keywordResult.action}`,
          payload: {
            sender: inbound.senderPhone,
            recipient: inbound.senderPhone, // Reply to the sender
            businessNumber,
            content: keywordResult.response,
            keyword: keywordResult.action,
            conversationId,
            ...scope,
          },
          response: null,
        });
      }
      return;
    }

    // --- Persist the inbound event under the attributed owner ---
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
          businessNumber,
          content: inbound.content,
          messageType: inbound.messageType,
          conversationId,
          attribution: args.basis,
          ...(args.holdId ? { holdId: args.holdId } : {}),
          ...scope,
        },
      });
    } catch (err) {
      console.error('[inbound_message] Neon write failed — failing job for retry', err);
      throw new Error('inbound_message: database write failed — retrying');
    }

    // --- Emit routed inbound event ---
    await deps.eventBus.emit({
      id: jobId,
      timestamp: new Date().toISOString(),
      appId,
      ...scope,
      category: 'messaging',
      providerId,
      status: 'success',
      latency: 0,
      cost: 0,
      decisionReason: `inbound_routed: ${inbound.senderPhone} → app:${appId} tenant:${tenantId}${supplierId ? ` supplier:${supplierId}` : ''} (${args.basis})`,
      payload: {
        sender: inbound.senderPhone,
        recipient: inbound.recipientPhone,
        businessNumber,
        content: inbound.content,
        messageType: inbound.messageType,
        conversationId,
        ...scope,
      },
      response: null,
    });
  }

  /** Quarantine a message no single owner can be established for. Never delivers, never drops. */
  async function hold(args: {
    jobId: string;
    dedupeKey: string;
    providerId: string;
    inbound: NormalizedInbound;
    businessNumber: string | null;
    reason: 'ambiguous_owner' | 'no_owner';
    candidates: readonly InboundHoldCandidate[];
    explanation: string;
    rawPayload: unknown;
  }): Promise<void> {
    const keyword = classifyKeyword(args.inbound.content);
    const { hold: row, created } = await inboundMessageHoldRepository.createOrGet({
      dedupeKey: args.dedupeKey,
      providerId: args.providerId,
      customerPhone: args.inbound.senderPhone,
      businessNumber: args.businessNumber,
      channel: args.inbound.channel,
      content: args.inbound.content,
      keyword,
      reason: args.reason,
      candidates: [...args.candidates],
      rawPayload: args.rawPayload,
    });

    // STOP / START on the shared number: honored at the NUMBER level
    // immediately (carrier semantics), never at any guessed tenant's level.
    // Idempotent; a failure throws so the job retries (never swallowed).
    let senderLevel: 'opted_out' | 'opted_in' | null = null;
    if ((keyword === 'STOP' || keyword === 'JOIN') && args.businessNumber && !row.senderOptOutApplied) {
      senderLevel = keyword === 'STOP' ? 'opted_out' : 'opted_in';
      await senderOptOutRepository.upsert({
        businessNumber: args.businessNumber,
        recipient: args.inbound.senderPhone,
        channel: args.inbound.channel,
        status: senderLevel,
        source: 'keyword_held',
        keyword,
        holdId: row.id,
      });
      await inboundMessageHoldRepository.markSenderOptOutApplied(row.id);
    }

    console.warn(
      `[inbound_message] HELD ${row.id} (${args.reason}${keyword ? `, keyword ${keyword}` : ''}) from ${args.inbound.senderPhone} to ${args.businessNumber ?? '<no destination>'} via ${args.providerId}: ${args.explanation}`,
    );

    // Platform-level operator signal. Deliberately carries NO content, NO
    // candidate identities and NO tenantId — it is not addressed to any
    // tenant, so webhook dispatch (which requires a tenantId, Phase 7)
    // delivers it to nobody.
    if (created) {
      await deps.eventBus.emit({
        id: `${args.jobId}_held`,
        timestamp: new Date().toISOString(),
        appId: PLATFORM_EVENT_APP_ID,
        category: 'messaging',
        providerId: args.providerId,
        status: 'pending',
        latency: 0,
        cost: 0,
        decisionReason: `inbound_held:${args.reason}`,
        payload: {
          holdId: row.id,
          reason: args.reason,
          candidateCount: args.candidates.length,
          keyword,
          senderLevelConsent: senderLevel,
        },
        response: null,
      });
    }
  }

  /** Deliver a held message an operator has attributed (admin resolve route enqueues this). */
  async function deliverResolvedHold(jobId: string, holdId: string): Promise<void> {
    const row = await inboundMessageHoldRepository.findById(holdId);
    if (!row) {
      console.warn(`[inbound_message] hold ${holdId} not found — nothing to deliver`);
      return;
    }
    if (row.status !== 'resolved' || !row.resolvedAppId || !row.resolvedTenantId) {
      // pending (not yet attributed), discarded, or already delivered.
      console.warn(`[inbound_message] hold ${holdId} is '${row.status}' — not delivering`);
      return;
    }
    // The owner comes from the hold ROW (written by the admin route, which
    // only accepts one of the hold's recorded candidates) — never from the
    // job payload.
    const owner: ConversationOwner = {
      appId: row.resolvedAppId,
      tenantId: row.resolvedTenantId,
      supplierId: row.resolvedSupplierId ?? null,
    };
    const conversation = await conversationRepository.upsert(row.customerPhone, owner.appId, {
      tenantId: owner.tenantId,
      supplierId: owner.supplierId,
      businessNumber: row.businessNumber,
      providerId: row.providerId,
      channel: row.channel,
    });
    const candidates = (row.candidates ?? []) as InboundHoldCandidate[];
    await deliverToOwner({
      jobId,
      providerId: row.providerId,
      owner,
      conversationId: conversation.id,
      inbound: {
        senderPhone: row.customerPhone,
        recipientPhone: row.businessNumber ?? '',
        content: row.content,
        channel: row.channel,
        providerMessageId: null,
        messageType: 'message',
      },
      businessNumber: row.businessNumber,
      sharedNumber: candidates.length > 1,
      basis: `operator:${row.resolvedBy ?? 'unknown'}`,
      holdId: row.id,
    });
    await inboundMessageHoldRepository.markDelivered(row.id);
  }

  return async (job) => {
    const { providerId, payload, holdId } = job.payload;

    if (typeof holdId === 'string' && holdId) {
      return deliverResolvedHold(job.id, holdId);
    }

    if (!providerId || !payload) {
      throw new Error('inbound_message requires providerId and payload');
    }

    // --- Step 1: Normalize the inbound message from provider webhook ---
    const inbound = normalizeInboundPayload(providerId, payload);

    if (!inbound.senderPhone) {
      // No From at all: not a customer message (e.g. a payment provider's
      // webhook, which also reaches this job — gap register A15).
      console.warn(`[inbound_message] No sender in webhook from ${providerId} — not a customer message, ignoring`);
      return;
    }

    // --- Step 2: provider → destination number → owner → conversation ---
    const resolution = await resolver.resolve({
      senderPhone: inbound.senderPhone,
      providerId,
      recipientPhone: inbound.recipientPhone,
      channel: inbound.channel,
    });

    if (resolution.kind === 'routed') {
      if (!resolution.created) {
        await conversationRepository.touch(resolution.conversation.id).catch(() => undefined);
      }
      return deliverToOwner({
        jobId: job.id,
        providerId,
        owner: resolution.owner,
        conversationId: resolution.conversation.id,
        inbound,
        businessNumber: resolution.businessNumber,
        sharedNumber: resolution.sharedNumber,
        basis: resolution.basis,
      });
    }

    // Not attributable to exactly one owner.
    if (inbound.messageType !== 'message') {
      // A provider status callback / delivery receipt is not customer
      // content and carries nothing to quarantine (unchanged behaviour).
      console.warn(`[inbound_message] ${inbound.messageType} from ${providerId} not attributable (${resolution.reason}) — ignoring`);
      return;
    }

    const webhookEventId = typeof job.payload.webhookEventId === 'string' ? job.payload.webhookEventId : null;
    const dedupeKey = webhookEventId
      ? `webhook_event:${webhookEventId}`
      : inbound.providerMessageId
        ? `provider_message:${providerId}:${inbound.providerMessageId}`
        : `job:${job.id}`;

    await hold({
      jobId: job.id,
      dedupeKey,
      providerId,
      inbound,
      businessNumber: resolution.businessNumber,
      reason: resolution.kind === 'ambiguous' ? 'ambiguous_owner' : 'no_owner',
      candidates: resolution.kind === 'ambiguous' ? resolution.candidates : [],
      explanation: resolution.reason,
      rawPayload: payload,
    });
  };
}

/**
 * Normalizes various provider webhook formats into a standard inbound message.
 * Different providers (Twilio, Africa's Talking, etc.) send different shapes.
 */
export function normalizeInboundPayload(
  _providerId: string,
  payload: any,
): NormalizedInbound {
  // Common webhook shapes:
  // Twilio: { From, To, Body, MessageSid, NumMedia }
  // Africa's Talking: { from, to, text, id }
  // Generic: { sender, recipient, content, type }

  const rawSender =
    payload.From || payload.from || payload.sender || payload.source || '';
  const rawRecipient =
    payload.To || payload.to || payload.recipient || payload.destination || '';
  const content =
    payload.Body || payload.body || payload.text || payload.content || '';
  const rawType =
    payload.type || payload.event || payload.status || 'message';
  const providerMessageId =
    payload.MessageSid || payload.SmsMessageSid || payload.messageId || payload.message_id || payload.id || null;

  // Determine message type
  let messageType: NormalizedInbound['messageType'] = 'message';
  if (typeof rawType === 'string') {
    const lower = rawType.toLowerCase();
    if (lower.includes('status') || lower.includes('update')) {
      messageType = 'status_update';
    } else if (lower.includes('receipt') || lower.includes('delivery') || lower.includes('sent') || lower.includes('delivered') || lower.includes('failed')) {
      messageType = 'delivery_receipt';
    }
  }

  // Phase 8: one canonical address form (gap register A3.5 — there was no
  // normalisation anywhere in this path), and the channel taken from the
  // address scheme rather than hardcoded (partial A6: 'whatsapp:+1...').
  const declaredChannel = typeof payload.channel === 'string' ? payload.channel.toLowerCase() : undefined;
  const channel = channelFromAddress(rawSender) ?? channelFromAddress(rawRecipient)
    ?? (declaredChannel === 'whatsapp' ? 'whatsapp' : 'sms');

  return {
    senderPhone: normalizeMessagingAddress(String(rawSender)),
    recipientPhone: normalizeMessagingAddress(String(rawRecipient)),
    content: String(content),
    channel,
    providerMessageId: providerMessageId != null && String(providerMessageId).length <= 255 ? String(providerMessageId) : null,
    messageType,
  };
}
