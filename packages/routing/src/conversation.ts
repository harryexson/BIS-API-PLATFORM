import { conversationRepository } from '@company/database';

export interface ConversationContext {
  phoneNumber: string;
  appId: string;
  // P0 FIX: tenantId is now required for multi-tenant conversation isolation.
  // Apps that don't use tenants should pass 'default'.
  tenantId: string;
}

export interface ConversationResult {
  providerId: string;
  channel: string;
  isExisting: boolean;
}

export class ConversationManager {
  /**
   * P0 FIX: Resolves the provider for a phone number based on conversation history.
   *
   * Lookups now include tenantId — two tenants within the same app sharing a
   * phone number get separate conversations, preventing cross-tenant bleed.
   */
  async resolve(ctx: ConversationContext): Promise<ConversationResult | null> {
    try {
      const existing = await conversationRepository.findByPhoneAndApp(
        ctx.phoneNumber,
        ctx.appId,
        ctx.tenantId,
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
