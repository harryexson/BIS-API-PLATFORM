import { conversationRepository } from '@company/database';

export interface ConversationContext {
  phoneNumber: string;
  appId: string;
  // P0 FIX: tenantId is now required for multi-tenant conversation isolation.
  // Apps that don't use tenants should pass 'default'.
  tenantId: string;
  // Phase 8: the verified supplier/business scope of the send, if any
  // (Afribook vendor, STAYSCAPE hotel). Part of the conversation's owner key.
  supplierId?: string | null;
}

export interface ConversationResult {
  providerId: string;
  channel: string;
  isExisting: boolean;
  /** Phase 8: the business number the existing conversation is on, if recorded. */
  businessNumber?: string | null;
}

/** Phase 8: where an outbound send went FROM (recorded on the conversation). */
export interface ConversationSenderInfo {
  businessNumber?: string | null;
  messagingProfileId?: string | null;
  country?: string | null;
}

export class ConversationManager {
  /**
   * Resolves the provider for an outbound send based on this OWNER's own
   * conversation history (app, tenant and — Phase 8 — supplier). Only ever
   * looks at the sending owner's threads, so recency here can never pick
   * another tenant's conversation.
   */
  async resolve(ctx: ConversationContext): Promise<ConversationResult | null> {
    try {
      const threads = await conversationRepository.findActiveForOwner(ctx.phoneNumber, {
        appId: ctx.appId,
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId ?? null,
      });
      const existing = threads[0];
      if (existing && existing.status === 'active') {
        return {
          providerId: existing.providerId,
          channel: existing.channel,
          isExisting: true,
          businessNumber: existing.businessNumber ?? null,
        };
      }

      return null;
    } catch {
      // If conversation lookup fails, fall through to normal routing
      return null;
    }
  }

  /**
   * Records or updates a conversation after a successful message delivery,
   * on the business number the message was actually sent from (Phase 8).
   */
  async record(
    ctx: ConversationContext,
    providerId: string,
    channel: string,
    sender: ConversationSenderInfo = {},
  ): Promise<void> {
    try {
      await conversationRepository.upsert(ctx.phoneNumber, ctx.appId, {
        providerId,
        channel,
        tenantId: ctx.tenantId,
        supplierId: ctx.supplierId ?? null,
        businessNumber: sender.businessNumber ?? null,
        ...(sender.messagingProfileId !== undefined ? { messagingProfileId: sender.messagingProfileId } : {}),
        ...(sender.country !== undefined ? { country: sender.country } : {}),
      });
    } catch {
      // Non-fatal — conversation tracking is best-effort
    }
  }

  /**
   * Closes a conversation (e.g., after opt-out or timeout).
   * P0 FIX: Now scoped to the specific tenant.
   */
  async close(phoneNumber: string, appId: string, tenantId: string = 'default'): Promise<void> {
    try {
      await conversationRepository.close(phoneNumber, appId, tenantId);
    } catch {
      // Non-fatal
    }
  }
}
