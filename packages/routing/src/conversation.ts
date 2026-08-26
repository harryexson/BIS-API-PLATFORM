import { conversationRepository } from '@company/database';

export interface ConversationContext {
  phoneNumber: string;
  appId: string;
  tenantId?: string;
}

export interface ConversationResult {
  providerId: string;
  channel: string;
  isExisting: boolean;
}

export class ConversationManager {
  /**
   * Resolves the provider for a phone number based on conversation history.
   *
   * If an active conversation exists for (phoneNumber, appId), the same
   * provider and channel are reused — ensuring conversation continuity
   * even when the same phone number is shared across apps.
   *
   * If no conversation exists, returns null so the routing engine can
   * select a provider normally.
   */
  async resolve(ctx: ConversationContext): Promise<ConversationResult | null> {
    try {
      const existing = await conversationRepository.findByPhoneAndApp(
        ctx.phoneNumber,
        ctx.appId,
      );

      if (existing && existing.status === 'active') {
        return {
          providerId: existing.providerId,
          channel: existing.channel,
          isExisting: true,
        };
      }

      return null;
    } catch {
      // If conversation lookup fails, fall through to normal routing
      return null;
    }
  }

  /**
   * Records or updates a conversation after a successful message delivery.
   */
  async record(
    ctx: ConversationContext,
    providerId: string,
    channel: string,
  ): Promise<void> {
    try {
      await conversationRepository.upsert(ctx.phoneNumber, ctx.appId, {
        providerId,
        channel,
        tenantId: ctx.tenantId,
      });
    } catch {
      // Non-fatal — conversation tracking is best-effort
    }
  }

  /**
   * Closes a conversation (e.g., after opt-out or timeout).
   */
  async close(phoneNumber: string, appId: string): Promise<void> {
    try {
      await conversationRepository.close(phoneNumber, appId);
    } catch {
      // Non-fatal
    }
  }
}
