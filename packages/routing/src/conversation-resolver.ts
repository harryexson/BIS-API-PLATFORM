import {
  conversationRepository,
  messagingProfileRepository,
  normalizeMessagingAddress,
  type InboundHoldCandidate,
} from '@company/database';

/**
 * Phase 8 — inbound conversation ownership on SHARED phone numbers
 * (gap register A1, A2, A3, D12).
 *
 * The platform deliberately shares one local number per country across many
 * tenants. An inbound message therefore has to be attributed through the
 * chain
 *
 *   provider → destination number → application → tenant → supplier
 *            → customer → conversation → workflow
 *
 * using ONLY server-side data:
 *   1. destination number + provider → messaging_profiles → the set of
 *      owners (app, tenant, supplier?) registered on that number;
 *   2. the customer's active conversations, narrowed to those that are ON
 *      that number (conversations.business_number) or — for rows written
 *      before Phase 8, which never recorded a number — that belong to one of
 *      the owners registered on it;
 *   3. distinct OWNERS among what is left:
 *        exactly one  → ROUTE to it;
 *        more than one → AMBIGUOUS: do not guess;
 *        none, and the number has exactly one registered owner → ROUTE to
 *          that owner (a first inbound on a dedicated number);
 *        none, and several registered owners → AMBIGUOUS;
 *        none, and no registered owner → UNROUTABLE.
 *
 * What changed vs. the pre-Phase-8 resolver, and why:
 *  - It compared `c.phoneNumber === recipientPhone`, but phone_number is the
 *    CUSTOMER, so that disambiguation could never fire (A2). The business
 *    number now has its own column and is compared against that.
 *  - On ambiguity it returned the most recently active conversation
 *    alongside confidence:'ambiguous', and the worker acted on it — content,
 *    STOP, YES/NO all went to whichever tenant messaged last (A3). Recency
 *    is now never used to choose between owners, and the ambiguous result
 *    carries NO conversation and NO owner: the type below makes it
 *    impossible to read delivery fields without first checking `kind`.
 *  - Conversations were filtered by providerId, so a provider failover made
 *    a live conversation unreachable (A3.5). The recorded business number is
 *    now the signal; provider equality is only used for legacy rows on a
 *    number nobody has registered.
 */

/** The owner an inbound message is attributed to. */
export interface ConversationOwner {
  appId: string;
  tenantId: string;
  supplierId: string | null;
}

/** The conversation an inbound message was attributed to (routed only). */
export interface ResolvedConversation {
  id: string;
  phoneNumber: string;
  businessNumber: string | null;
  appId: string;
  tenantId: string;
  supplierId: string | null;
  providerId: string;
  channel: string;
  workflowId: string | null;
  country: string | null;
}

export type ConversationResolution =
  | {
      kind: 'routed';
      owner: ConversationOwner;
      conversation: ResolvedConversation;
      /** true when this inbound message opened the conversation (dedicated number, no prior thread). */
      created: boolean;
      /** How the owner was established. */
      basis: 'conversation' | 'destination_profile';
      /** Normalized destination number, when the webhook carried one. */
      businessNumber: string | null;
      /** More than one owner is registered on this destination number (it is a shared number). */
      sharedNumber: boolean;
      reason: string;
    }
  | {
      kind: 'ambiguous';
      /**
       * Owners that could plausibly own this message — recorded on the
       * quarantine hold so an operator can choose among them. Deliberately
       * NOT a conversation and NOT ordered by recency: nothing here is a
       * routing decision.
       */
      candidates: readonly InboundHoldCandidate[];
      businessNumber: string | null;
      sharedNumber: boolean;
      reason: string;
    }
  | {
      kind: 'unroutable';
      businessNumber: string | null;
      reason: string;
    };

export interface ConversationResolveInput {
  /** The customer's number (webhook From). */
  senderPhone: string;
  /** The provider the webhook came from. */
  providerId: string;
  /** The number the message was sent TO (webhook To) — the business number. */
  recipientPhone?: string | null;
  /** Channel the message arrived on, used if a conversation has to be opened. */
  channel?: string;
}

interface ConversationRow {
  id: string;
  phoneNumber: string;
  businessNumber?: string | null;
  appId: string;
  tenantId: string;
  supplierId?: string | null;
  providerId: string;
  channel: string;
  workflowId?: string | null;
  country?: string | null;
  lastMessageAt?: Date | string | null;
}

interface ProfileRow {
  id: string;
  appId: string;
  tenantId: string;
  supplierId?: string | null;
  country: string;
}

/** Injectable data access (defaults to @company/database's repositories). */
export interface ConversationResolverDeps {
  conversations: {
    findActiveByPhone(phone: string): Promise<ConversationRow[]>;
    upsert(
      phone: string,
      appId: string,
      data: {
        providerId: string;
        channel: string;
        tenantId: string;
        supplierId?: string | null;
        businessNumber?: string | null;
        messagingProfileId?: string | null;
        country?: string | null;
      },
    ): Promise<ConversationRow>;
  };
  profiles: {
    findOwnersOfSender(sender: string, provider: string): Promise<ProfileRow[]>;
  };
}

const ownerKey = (o: { appId: string; tenantId: string; supplierId?: string | null }) =>
  `${o.appId}\u0000${o.tenantId}\u0000${o.supplierId ?? ''}`;

function toResolved(c: ConversationRow): ResolvedConversation {
  return {
    id: c.id,
    phoneNumber: c.phoneNumber,
    businessNumber: c.businessNumber ?? null,
    appId: c.appId,
    tenantId: c.tenantId,
    supplierId: c.supplierId ?? null,
    providerId: c.providerId,
    channel: c.channel,
    workflowId: c.workflowId ?? null,
    country: c.country ?? null,
  };
}

function activityTime(c: ConversationRow): number {
  const v = c.lastMessageAt;
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Does a registration on the destination number cover this (legacy) conversation's owner? */
function profileCovers(p: ProfileRow, c: ConversationRow): boolean {
  return (
    p.appId === c.appId &&
    p.tenantId === c.tenantId &&
    (p.supplierId == null || p.supplierId === (c.supplierId ?? null))
  );
}

export class ConversationResolver {
  private readonly deps: ConversationResolverDeps;

  constructor(deps?: Partial<ConversationResolverDeps>) {
    this.deps = {
      conversations: deps?.conversations ?? (conversationRepository as unknown as ConversationResolverDeps['conversations']),
      profiles: deps?.profiles ?? (messagingProfileRepository as unknown as ConversationResolverDeps['profiles']),
    };
  }

  async resolve(input: ConversationResolveInput): Promise<ConversationResolution> {
    const customer = normalizeMessagingAddress(input.senderPhone);
    const destination = normalizeMessagingAddress(input.recipientPhone ?? '') || null;
    const providerId = input.providerId;

    // provider → destination number → registered owners
    const profiles = destination ? await this.deps.profiles.findOwnersOfSender(destination, providerId) : [];
    const registeredOwners = new Map<string, ProfileRow>();
    for (const p of profiles) {
      const key = ownerKey(p);
      if (!registeredOwners.has(key)) registeredOwners.set(key, p);
    }
    const sharedNumber = registeredOwners.size > 1;

    // customer → conversations ON this destination (or legacy rows of a registered owner)
    const all = await this.deps.conversations.findActiveByPhone(customer);
    const plausible = all.filter((c) => {
      if (!destination) {
        // The webhook carried no destination at all: no number signal, so
        // fall back to the provider (still never to recency).
        return c.providerId === providerId;
      }
      if (c.businessNumber) return c.businessNumber === destination;
      // Legacy row (written before business_number existed).
      if (profiles.length > 0) return profiles.some((p) => profileCovers(p, c));
      return c.providerId === providerId;
    });

    // Distinct owners among the plausible conversations.
    const byOwner = new Map<string, ConversationRow[]>();
    for (const c of plausible) {
      const key = ownerKey(c);
      const list = byOwner.get(key) ?? [];
      list.push(c);
      byOwner.set(key, list);
    }

    if (byOwner.size === 1) {
      const threads = [...byOwner.values()][0];
      // Choosing among ONE owner's own threads: prefer the one recorded on
      // this exact number, then the most recently active. This never
      // crosses a tenant boundary.
      threads.sort((a, b) => {
        const exactA = destination && a.businessNumber === destination ? 1 : 0;
        const exactB = destination && b.businessNumber === destination ? 1 : 0;
        if (exactA !== exactB) return exactB - exactA;
        return activityTime(b) - activityTime(a);
      });
      const chosen = threads[0];
      return {
        kind: 'routed',
        owner: { appId: chosen.appId, tenantId: chosen.tenantId, supplierId: chosen.supplierId ?? null },
        conversation: toResolved(chosen),
        created: false,
        basis: 'conversation',
        businessNumber: destination,
        sharedNumber,
        reason: destination
          ? `exactly one owner has an active conversation with this customer on ${destination}${sharedNumber ? ` (shared by ${registeredOwners.size} registered owners)` : ''}`
          : `exactly one owner has an active conversation with this customer via ${providerId} (webhook carried no destination number)`,
      };
    }

    if (byOwner.size > 1) {
      const candidates = [...byOwner.values()]
        .map((threads) => {
          const c = threads[0];
          const exact = threads.find((t) => destination && t.businessNumber === destination);
          return {
            appId: c.appId,
            tenantId: c.tenantId,
            supplierId: c.supplierId ?? null,
            conversationId: (exact ?? c).id,
          };
        })
        .sort((a, b) => ownerKey(a).localeCompare(ownerKey(b)));
      return {
        kind: 'ambiguous',
        candidates,
        businessNumber: destination,
        sharedNumber,
        reason: `${candidates.length} different owners have an active conversation with this customer on ${destination ?? `provider ${providerId}`} — not guessing`,
      };
    }

    // No conversation on this number.
    if (registeredOwners.size === 1 && destination) {
      const profile = [...registeredOwners.values()][0];
      const row = await this.deps.conversations.upsert(customer, profile.appId, {
        tenantId: profile.tenantId,
        supplierId: profile.supplierId ?? null,
        businessNumber: destination,
        messagingProfileId: profile.id,
        country: profile.country,
        providerId,
        channel: input.channel || 'sms',
      });
      return {
        kind: 'routed',
        owner: { appId: profile.appId, tenantId: profile.tenantId, supplierId: profile.supplierId ?? null },
        conversation: toResolved(row),
        created: true,
        basis: 'destination_profile',
        businessNumber: destination,
        sharedNumber: false,
        reason: `${destination} is registered to exactly one owner (messaging profile ${profile.id})`,
      };
    }

    if (registeredOwners.size > 1) {
      const candidates = [...registeredOwners.values()]
        .map((p) => ({ appId: p.appId, tenantId: p.tenantId, supplierId: p.supplierId ?? null, conversationId: null }))
        .sort((a, b) => ownerKey(a).localeCompare(ownerKey(b)));
      return {
        kind: 'ambiguous',
        candidates,
        businessNumber: destination,
        sharedNumber: true,
        reason: `${destination} is shared by ${candidates.length} owners and this customer has no conversation on it — not guessing`,
      };
    }

    return {
      kind: 'unroutable',
      businessNumber: destination,
      reason: destination
        ? `no owner is registered on ${destination} via ${providerId} and this customer has no conversation on it`
        : `no active conversation for this customer via ${providerId} and the webhook carried no destination number`,
    };
  }
}
