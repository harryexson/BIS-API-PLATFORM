import { conversationRepository } from '@company/database';

export interface ConversationResolution {
  conversation: {
    id: string;
    phoneNumber: string;
    appId: string;
    tenantId: string;
    providerId: string;
    channel: string;
  } | null;
  confidence: 'exact' | 'ambiguous' | 'none';
  reason: string;
}

/**
 * P0: Deterministic conversation resolution service.
 *
 * When a customer has conversations with multiple applications (e.g., Hotel A
 * and Hotel B) and sends "YES", the system must not guess. This resolver uses
 * the recipient phone number from the webhook as the primary disambiguation signal.
 *
 * STOP remains globally enforceable even if business routing is ambiguous.
 */
export class ConversationResolver {
  /**
   * Resolves which conversation owns an inbound message.
   *
   * @param senderPhone - The phone number that sent the message
   * @param providerId - The provider that delivered the webhook
   * @param content - The message content (for keyword handling context)
   * @param recipientPhone - The phone number the message was sent TO (from webhook metadata)
   * @param appId - Optional: filter to a specific application for stricter isolation
   * @param tenantId - Optional: filter to a specific tenant for stricter isolation
   */
  async resolve(
    senderPhone: string,
    providerId: string,
    content: string,
    recipientPhone?: string,
    appId?: string,
    tenantId?: string,
  ): Promise<ConversationResolution> {
    // 1. Find all active conversations for this phone number
    let allConversations = await conversationRepository.findActiveByPhone(senderPhone);

    // P0: If appId is provided, filter for stricter isolation
    if (appId) {
      allConversations = allConversations.filter((c) => c.appId === appId);
    }
    if (tenantId) {
      allConversations = allConversations.filter((c) => c.tenantId === tenantId);
    }

    // 2. Filter by providerId
    let candidates = allConversations.filter(
      (c) => c.providerId === providerId,
    );

    // 3. If webhook metadata includes recipientPhone, use it for disambiguation
    if (recipientPhone && candidates.length > 1) {
      const exactMatch = candidates.find((c) => c.phoneNumber === recipientPhone);
      if (exactMatch) {
        return {
          conversation: exactMatch,
          confidence: 'exact',
          reason: `recipientPhone ${recipientPhone} matches conversation directly`,
        };
      }
    }

    // 4. If exactly one match → exact
    if (candidates.length === 1) {
      return {
        conversation: candidates[0],
        confidence: 'exact',
        reason: 'single matching conversation',
      };
    }

    // 5. If multiple matches → ambiguous
    if (candidates.length > 1) {
      // Sort by lastMessageAt descending (most recent first)
      candidates.sort((a, b) => {
        const aTime = a.lastMessageAt?.getTime?.() || (a.lastMessageAt ? new Date(a.lastMessageAt as any).getTime() : 0);
        const bTime = b.lastMessageAt?.getTime?.() || (b.lastMessageAt ? new Date(b.lastMessageAt as any).getTime() : 0);
        return bTime - aTime;
      });

      console.warn(
        `[conversation_resolver] Ambiguous routing for ${senderPhone}: ${candidates.length} candidates`,
        candidates.map((c) => `${c.appId}/${c.tenantId}`),
      );

      return {
        conversation: candidates[0],
        confidence: 'ambiguous',
        reason: `${candidates.length} active conversations for ${senderPhone} via ${providerId}`,
      };
    }

    // 6. No matches
    return {
      conversation: null,
      confidence: 'none',
      reason: `no active conversation for ${senderPhone} via ${providerId}`,
    };
  }
}
