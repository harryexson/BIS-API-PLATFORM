import { logger } from '@company/observability';
import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import type { JobQueue } from '../queue';
import {
  eventRepository,
  conversationRepository,
  inboundMessageHoldRepository,
  senderOptOutRepository,
  keywordCommandRepository,
  keywordCommandDispatchRepository,
  normalizeMessagingAddress,
  channelFromAddress,
  type InboundHoldCandidate,
} from '@company/database';
import {
  handleKeyword,
  classifyKeyword,
  matchKeywordCommand,
  ConversationResolver,
  type ConversationOwner,
  type KeywordResult,
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
 *
 * Phase 9 (gap register A13) — keyword commands, once the owner is known:
 *   receive → provider → destination number → owner (resolver) →
 *   conversation → keyword recognition against THAT owner's configuration
 *   (universal STOP/START/HELP/YES/NO first, then the owner's own
 *   keyword_commands) → dispatch:
 *     universal / 'reply' command → handled here; the reply is ENQUEUED for
 *       real delivery (keyword_response_delivery — it used to be emitted on
 *       the bus only and never sent to the customer);
 *     'dispatch' command (e.g. HaulPro WHERE IS MY DRIVER) → a durable,
 *       deduplicated keyword_command_dispatches row + the conversation's
 *       workflow_id + a tenant-scoped 'keyword_command' event the owning
 *       application consumes (webhook push or the pull API). The platform
 *       never answers the business question itself;
 *   → audit (events rows, consent/sender-opt-out rows, dispatch rows).
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

export function createInboundMessageProcessor(deps: JobDeps, queue?: JobQueue): JobProcessor {
  const resolver = new ConversationResolver();

  /**
   * Phase 9: hand a keyword reply to keyword_response_delivery so it is
   * really SENT (previously it was only emitted on the bus — nothing ever
   * enqueued the delivery job). Idempotent per inbound message: a retried
   * inbound job or redelivered webhook never sends the reply twice.
   */
  async function enqueueReply(args: {
    dedupeKey: string;
    providerId: string;
    owner: ConversationOwner;
    recipient: string;
    businessNumber: string | null;
    conversationId: string;
    result: KeywordResult;
    /** Phase 10: the channel the inbound message arrived on — the reply goes back on it. */
    channel: string;
  }): Promise<void> {
    if (!queue || !args.result.response) return;
    await queue.enqueue(
      'keyword_response_delivery',
      {
        senderPhone: args.recipient,
        content: args.result.response,
        appId: args.owner.appId,
        tenantId: args.owner.tenantId,
        supplierId: args.owner.supplierId,
        providerId: args.providerId,
        keyword: args.result.action,
        keywordName: args.result.keyword ?? null,
        conversationId: args.conversationId,
        businessNumber: args.businessNumber,
        channel: args.channel,
      },
      { idempotencyKey: `keyword_reply:${args.dedupeKey}` },
    );
  }

  /** Deliver a message to the ONE owner it was attributed to (pre-Phase-8 steps 3-5). */
  async function deliverToOwner(args: {
    jobId: string;
    /** Stable identity of this inbound message across job retries / webhook redeliveries. */
    dedupeKey: string;
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

    // --- Keyword commands: universal (STOP/START/HELP/YES/NO) + THIS owner's
    // configured ones (Phase 9). Only this owner's configuration is loaded —
    // never another tenant's. A lookup failure throws (job retries); it is
    // never mistaken for "no commands configured".
    const commands = await keywordCommandRepository.findEffectiveForOwner(appId, tenantId);
    const keywordResult = await handleKeyword({
      senderPhone: inbound.senderPhone,
      appId,
      tenantId,
      supplierId: owner.supplierId,
      content: inbound.content,
      providerId,
      channel: inbound.channel,
      commands,
      conversationId,
      attribution: args.basis,
      holdId: args.holdId ?? null,
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

      logger.info('inbound keyword handled', {
        operation: 'inbound_message',
        status: keywordResult.action,
        applicationId: appId,
        tenantId,
        conversationId,
        ...(keywordResult.command ? { command: keywordResult.command.keyword, commandMode: keywordResult.command.mode } : {}),
      });

      // --- App-specific command → generic dispatch to the owning application ---
      if (keywordResult.command?.mode === 'dispatch') {
        const cmd = keywordResult.command;
        const { dispatch } = await keywordCommandDispatchRepository.recordOnce({
          dedupeKey: args.dedupeKey,
          appId,
          tenantId,
          supplierId: owner.supplierId ?? null,
          conversationId,
          commandId: cmd.commandId,
          keyword: cmd.keyword,
          argument: cmd.argument,
          workflowId: cmd.workflowId,
          customerPhone: inbound.senderPhone,
          businessNumber,
          providerId,
          channel: inbound.channel,
          content: inbound.content,
          holdId: args.holdId ?? null,
        });
        if (cmd.workflowId) {
          // "Full pipeline through workflow resolution": the conversation now
          // records which application workflow this command started.
          await conversationRepository.setWorkflow(conversationId, cmd.workflowId);
        }
        // Tenant-scoped (appId + tenantId [+ supplierId]) — the gateway's
        // outbound-webhook fan-out delivers it to this owner's endpoints
        // only. The event id is derived from the durable dispatch row, so a
        // re-emit after a retry carries the same id (consumers dedupe on it).
        await deps.eventBus.emit({
          id: `keyword_dispatch_${dispatch.id}`,
          timestamp: new Date().toISOString(),
          appId,
          ...scope,
          category: 'messaging',
          messageType: 'keyword_command',
          providerId,
          status: 'pending',
          latency: 0,
          cost: 0,
          decisionReason: `keyword_command:${cmd.keyword}`,
          payload: {
            type: 'keyword.command',
            dispatchId: dispatch.id,
            keyword: cmd.keyword,
            argument: cmd.argument,
            workflowId: cmd.workflowId,
            conversationId,
            sender: inbound.senderPhone,
            businessNumber,
            channel: inbound.channel,
            content: inbound.content,
            receivedAt: dispatch.createdAt instanceof Date ? dispatch.createdAt.toISOString() : String(dispatch.createdAt),
            ...(args.holdId ? { holdId: args.holdId } : {}),
            ...scope,
          },
          response: null,
        });
      }

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
            keywordName: keywordResult.keyword ?? null,
            conversationId,
            ...scope,
          },
          response: null,
        });
        await enqueueReply({
          dedupeKey: args.dedupeKey,
          providerId,
          owner,
          recipient: inbound.senderPhone,
          businessNumber,
          conversationId,
          result: keywordResult,
          channel: inbound.channel,
        });
      }
      return;
    }

    // --- Persist the inbound event under the attributed owner ---
    try {
      await eventRepository.create({
        appId,
        // Phase 16 (gap register D14/D16): the attributed owner's tenant in
        // the column, not only in the payload.
        tenantId,
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
      logger.error('inbound message database write failed — failing job for retry', {
        operation: 'inbound_message',
        errorCode: 'DB_WRITE_FAILED',
        status: 'failed',
        error: err,
      });
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
    // Phase 9: an app-specific command is NOT used to pick an owner (that
    // would let any tenant claim ambiguous messages by registering common
    // words). It is only recorded per candidate as a hint for the operator
    // who attributes the hold.
    const candidates = keyword ? [...args.candidates] : await annotateCandidates(args.candidates, args.inbound.content);
    const { hold: row, created } = await inboundMessageHoldRepository.createOrGet({
      dedupeKey: args.dedupeKey,
      providerId: args.providerId,
      customerPhone: args.inbound.senderPhone,
      businessNumber: args.businessNumber,
      channel: args.inbound.channel,
      content: args.inbound.content,
      keyword,
      reason: args.reason,
      candidates,
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

    logger.warn('inbound message held for operator attribution', {
      operation: 'inbound_message',
      status: 'held',
      holdId: row.id,
      reason: args.reason,
      ...(keyword ? { keyword } : {}),
      providerId: args.providerId,
      explanation: args.explanation,
    });

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

  async function annotateCandidates(
    candidates: readonly InboundHoldCandidate[],
    content: string,
  ): Promise<InboundHoldCandidate[]> {
    const out: InboundHoldCandidate[] = [];
    for (const c of candidates) {
      const match = matchKeywordCommand(content, await keywordCommandRepository.findEffectiveForOwner(c.appId, c.tenantId));
      out.push(match ? { ...c, matchedCommand: match.keyword } : { ...c });
    }
    return out;
  }

  /** Deliver a held message an operator has attributed (admin resolve route enqueues this). */
  async function deliverResolvedHold(jobId: string, holdId: string): Promise<void> {
    const row = await inboundMessageHoldRepository.findById(holdId);
    if (!row) {
      logger.warn('inbound hold not found — nothing to deliver', { operation: 'inbound_message', status: 'skipped', holdId });
      return;
    }
    if (row.status !== 'resolved' || !row.resolvedAppId || !row.resolvedTenantId) {
      // pending (not yet attributed), discarded, or already delivered.
      logger.warn('inbound hold is not deliverable — not delivering', {
        operation: 'inbound_message',
        status: 'skipped',
        holdId,
        holdStatus: row.status,
      });
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
      dedupeKey: `hold:${row.id}`,
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
      logger.warn('no sender in inbound webhook — not a customer message, ignoring', {
        operation: 'inbound_message',
        status: 'ignored',
        providerId,
      });
      return;
    }

    const webhookEventId = typeof job.payload.webhookEventId === 'string' ? job.payload.webhookEventId : null;
    const dedupeKey = webhookEventId
      ? `webhook_event:${webhookEventId}`
      : inbound.providerMessageId
        ? `provider_message:${providerId}:${inbound.providerMessageId}`
        : `job:${job.id}`;

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
        dedupeKey,
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
      logger.warn('inbound non-message callback not attributable — ignoring', {
        operation: 'inbound_message',
        status: 'ignored',
        providerId,
        messageType: inbound.messageType,
        reason: resolution.reason,
      });
      return;
    }

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
