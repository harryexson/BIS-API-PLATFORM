import { randomUUID } from 'node:crypto';
import { ProviderConfig, TransactionEvent, PaymentRequest, PaymentRoutingRequest } from '@company/schemas';
import { ProviderRegistry, BaseProvider } from '@company/providers';
import {
  consentRecordRepository,
  messagingProfileRepository,
  senderOptOutRepository,
  normalizeMessagingAddress,
} from '@company/database';
import { ConversationManager, ConversationContext, type ConversationSenderInfo } from './conversation';
import { findMatchingRule, type RoutingContext } from './rules';
import { computeProviderScore, rankByScore, weightedRandomSelect, type ScorableCandidate } from './scoring';

export { ConversationManager, type ConversationContext } from './conversation';
export {
  ConversationResolver,
  type ConversationResolution,
  type ConversationResolveInput,
  type ConversationResolverDeps,
  type ConversationOwner,
  type ResolvedConversation,
} from './conversation-resolver';
export { handleKeyword, classifyKeyword, type KeywordClass, type KeywordContext, type KeywordResult } from './keywords';
export { evaluateRule, findMatchingRule, type RoutingContext } from './rules';
export { computeProviderScore, rankByScore, weightedRandomSelect, type ScorableCandidate } from './scoring';

// P0: How many providers a single payment/message will cascade through
// before giving up — the initial pick plus this many additional
// score-ranked fallbacks, not unbounded (each hop can cost up to
// PROVIDER_TIMEOUT_MS, and a payment cascade stops immediately on any
// timeout regardless of this cap — see routePayment).
const MAX_ROUTING_ATTEMPTS = Number(process.env.MAX_ROUTING_ATTEMPTS) || 3;

interface RankedCandidate extends ScorableCandidate {
  name: string;
}

/**
 * Thrown when an outbound send is blocked because the recipient has
 * opted out (STOP) on this channel and hasn't opted back in (JOIN/START).
 * Distinguishable from a generic routing failure so callers (the gateway)
 * can surface a 403 instead of a retryable 503 — retrying doesn't help.
 */
export class ConsentBlockedError extends Error {
  constructor(recipient: string, channel: string) {
    super(`Recipient ${recipient} has opted out of ${channel} messaging (STOP) — outbound blocked.`);
    this.name = 'ConsentBlockedError';
  }
}

/**
 * P1-4: Channel fallback policy.
 *
 * Defines whether channel switching (e.g., SMS → Email) is allowed.
 * Do NOT silently change a communication channel — the routing policy
 * must explicitly define whether fallback is permitted.
 */
export interface ChannelFallbackPolicy {
  /** Allow fallback to alternate SMS provider (e.g., SignalHouse → FutureSMS) */
  allowAlternateProvider: boolean;
  /** Allow channel switching (e.g., SMS → Email) — disabled by default */
  allowChannelSwitch: boolean;
  /** Whether channel switching requires recipient consent */
  requiresConsent: boolean;
}

const DEFAULT_FALLBACK_POLICY: ChannelFallbackPolicy = {
  allowAlternateProvider: true,
  allowChannelSwitch: false,
  requiresConsent: true,
};

// P1: Default provider request timeout (30 seconds).
// Prevents hung provider calls from blocking the entire gateway.
export const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 30_000;

/**
 * A timeout is not a normal failure: the request may have reached the
 * provider and been processed before the response was lost. Tagging it
 * distinctly lets payment routing refuse to treat "we don't know" the same
 * as "it definitely failed" (see routePayment's catch block below).
 */
export class ProviderTimeoutError extends Error {}

/**
 * Wraps a provider processRequest call with an AbortSignal timeout.
 * If the provider doesn't respond within the timeout, the call is aborted.
 */
async function withProviderTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<T> {
  // AbortSignal.timeout is available in Node 18+
  if (typeof AbortSignal.timeout === 'function') {
    const controller = AbortSignal.timeout(timeoutMs);
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        controller.addEventListener('abort', () =>
          reject(new ProviderTimeoutError(`Provider request timed out after ${timeoutMs}ms`)),
        ),
      ),
    ]);
  }
  // Fallback for environments without AbortSignal.timeout
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new ProviderTimeoutError(`Provider request timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

/** Phase 8: the sender-level STOP lookup failed — the send is aborted, never cascaded. */
class SenderConsentLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenderConsentLookupError';
  }
}

/**
 * Phase 8: ISO country for an E.164 number, ONLY for calling codes that map
 * to exactly one country (NANP '+1' is shared by US/CA/... and is left
 * undetermined). Used solely as a tie-breaker between an owner's own
 * per-country sender registrations — never for anything tenant-related.
 */
const SINGLE_COUNTRY_CALLING_CODES: Record<string, string> = {
  '265': 'MW', '260': 'ZM', '263': 'ZW', '258': 'MZ', '255': 'TZ', '254': 'KE', '256': 'UG',
  '250': 'RW', '257': 'BI', '251': 'ET', '27': 'ZA', '234': 'NG', '233': 'GH', '221': 'SN',
  '225': 'CI', '237': 'CM', '243': 'CD', '244': 'AO', '267': 'BW', '264': 'NA', '266': 'LS',
  '268': 'SZ', '44': 'GB', '353': 'IE', '61': 'AU', '64': 'NZ', '91': 'IN', '49': 'DE', '33': 'FR',
};

export function countryForE164(raw: string): string | undefined {
  const n = normalizeMessagingAddress(raw);
  if (!n.startsWith('+')) return undefined;
  const digits = n.slice(1);
  for (const len of [3, 2]) {
    const code = digits.slice(0, len);
    if (SINGLE_COUNTRY_CALLING_CODES[code]) return SINGLE_COUNTRY_CALLING_CODES[code];
  }
  return undefined;
}

export class RoutingEngine {
  private registry: ProviderRegistry;
  private conversationManager: ConversationManager;

  constructor() {
    this.registry = ProviderRegistry.getInstance();
    this.conversationManager = new ConversationManager();
  }

  // Capability-based payment routing — selects providers by capabilities/currency
  // rather than hardcoded provider IDs. Adding a new provider with the right
  // capabilities automatically makes it eligible for routing.
  //
  // Selection precedence: (1) an explicit providerOverride from the caller,
  // (2) an admin-configured routing rule whose match expression holds (see
  // packages/routing/src/rules.ts — this data has existed with full CRUD
  // and an admin console UI since an earlier pass, but was never actually
  // consulted here; every rule an admin created was purely decorative
  // until this pass), (3) success-rate/cost-scored selection among
  // capability-matched candidates (packages/routing/src/scoring.ts — real
  // signals: ProviderRegistry.recordTraffic's live rolling error rate and
  // the admin-configured transactionFeePercent/Flat, not just the static
  // weight the previous version used alone).
  //
  // On failure, cascades through the remaining score-ranked candidates
  // (up to MAX_ROUTING_ATTEMPTS total attempts) rather than the single
  // fixed fallback hop the previous version made — except a timeout,
  // which stops the cascade immediately at any point in the chain: the
  // provider may have already processed the charge, so retrying it
  // through another provider risks a real double charge on an outcome
  // that isn't actually known to have failed.
  //
  // Every field of the request — including paymentToken, country, metadata,
  // idempotencyKey and the platform's paymentTransactionId — is forwarded
  // unchanged to whichever adapter(s) are tried (gap register C1/E1/C11).
  // The SAME paymentTransactionId goes to every provider in a failover
  // cascade: each provider's idempotency namespace is its own, and the
  // platform transaction row being attempted is one and the same.
  public async routePayment(appId: string, request: PaymentRoutingRequest): Promise<TransactionEvent> {
    const event = await this.routePaymentAttempts(appId, request);
    return request.paymentTransactionId && !event.paymentTransactionId
      ? { ...event, paymentTransactionId: request.paymentTransactionId }
      : event;
  }

  private async routePaymentAttempts(appId: string, request: PaymentRoutingRequest): Promise<TransactionEvent> {
    // Adapters apply their own currency/paymentMethod defaults; the cast
    // reflects that PaymentRequest's required fields may be defaulted.
    const payload = request as PaymentRequest & { providerOverride?: string };
    const { currency = 'USD', paymentMethod = 'card', providerOverride, country } = request;
    const amount = Number(payload.amount);
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    const allProviders = this.registry.getAllConfigs();
    const activePayments = allProviders.filter(
      p => p.category === 'payment' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
    );

    if (activePayments.length === 0) {
      throw new Error('All payment providers are currently OFFLINE / UNDER MAINTENANCE');
    }

    // 1. Manual override
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (provider && this.registry.isProviderAvailable(providerOverride) && this.registry.isLiveEligible(providerOverride)) {
        selectedProvider = provider;
        reason = `Manual override matched: Forced routing to '${provider.config.name}'.`;
      } else {
        reason = `Manual override '${providerOverride}' requested but provider is offline/invalid/not production-eligible. Falling back. | `;
      }
    }

    // 2. Admin-configured routing rule
    if (!selectedProvider) {
      const ctx: RoutingContext = { currency: currency?.toUpperCase(), amount, paymentMethod, country: country?.toUpperCase() };
      const rule = findMatchingRule(this.registry.getEnabledRoutingRules(), ctx);
      if (rule) {
        const provider = this.registry.getProvider(rule.target);
        if (provider && this.registry.isProviderAvailable(rule.target) && this.registry.isLiveEligible(rule.target)) {
          selectedProvider = provider;
          reason += `Routing rule matched ('${rule.match}'${rule.description ? ` — ${rule.description}` : ''}): routed to '${provider.config.name}'.`;
        } else {
          reason += `Routing rule matched ('${rule.match}') but target '${rule.target}' is offline/invalid. Falling back. | `;
        }
      }
    }

    // 3. Capability + success-rate/cost-scored candidate pool — also the
    // basis for the cascading fallback order below, whether or not step 1
    // or 2 already picked a provider.
    const cur = currency.toUpperCase();
    const capabilities = [paymentMethod];
    if (paymentMethod === 'mobile_money') capabilities.push('mobile_money');

    let candidatePool: RankedCandidate[] = this.registry.findByCategoryAndCapabilities('payment', capabilities, cur, country);
    let poolDescription = `capability match for ${cur}/${paymentMethod}${country ? `/${String(country).toUpperCase()}` : ''}`;
    if (candidatePool.length === 0) {
      candidatePool = activePayments.filter(p => ['stripe', 'nmi', 'airwallex'].includes(p.id));
      poolDescription = 'global weight-allocation fallback pool';
    }
    const ranked = rankByScore(candidatePool, { amount });

    if (!selectedProvider && ranked.length > 0) {
      const chosen = weightedRandomSelect(ranked, c => computeProviderScore(c, { amount }));
      const provider = this.registry.getProvider(chosen.id);
      if (provider) {
        selectedProvider = provider;
        reason += `Success-rate/cost-scored routing (${poolDescription}): candidates [${ranked.map(c => c.name).join(', ')}]. Selected '${chosen.name}' (error rate ${(chosen.errorRate ?? 0).toFixed(1)}%).`;
      }
    }

    if (!selectedProvider) {
      throw new Error('Routing failure: Unable to find a suitable online payment provider.');
    }

    const fallbackOrder = ranked.filter(c => c.id !== selectedProvider!.config.id);
    const attemptedIds = new Set<string>();
    let currentProvider = selectedProvider;
    let currentReason = reason;

    for (let attempt = 1; ; attempt++) {
      attemptedIds.add(currentProvider.config.id);

      // A soft decline (the provider call succeeded and returned a
      // definite 'failed' TransactionEvent — a real decline, not an
      // infrastructure failure) is just as safe to retry via another
      // provider/acquirer as a thrown error: the charge is known NOT to
      // have moved money. This is what real orchestration platforms mean
      // by "retry logic" — without this branch, only network/HTTP-level
      // failures ever cascaded, and an ordinary declined card silently
      // returned as failed with no failover, despite the cascade
      // machinery existing right here.
      let event: TransactionEvent | undefined;
      let declineMessage: string | undefined;
      try {
        // P1: Wrap provider call with timeout to prevent hung requests
        event = await withProviderTimeout(() => currentProvider!.processRequest(appId, payload, currentReason));
      } catch (err: any) {
        if (err instanceof ProviderTimeoutError) {
          // Phase 6 (gap register D4): the provider's own id was never
          // received, so there is none to report. The event's id is the
          // platform's own pre-allocated, stable payment transaction id —
          // NOT a throwaway randomUUID() (which used to be stored as the
          // row's provider_transaction_id, where no later provider webhook
          // or status check could ever match it). The gateway stores
          // provider_transaction_id = NULL for this case (see
          // paymentOutcomeFromEvent in @company/database) and the row in the
          // distinct 'unknown' status. Only a caller that allocated no row
          // gets a clearly-labelled placeholder.
          return {
            id: request.paymentTransactionId || `unknown_${randomUUID()}`,
            timestamp: new Date().toISOString(),
            appId,
            category: 'payment',
            providerId: currentProvider.config.id,
            status: 'unknown',
            amount,
            currency,
            latency: PROVIDER_TIMEOUT_MS,
            cost: 0,
            decisionReason: `${currentReason} | Ambiguous outcome: ${err.message}. Not retried via another provider — outcome must be reconciled via webhook/status check before any further action.`,
            payload,
            response: null,
            error: err.message,
          };
        }
        declineMessage = err.message;
      }

      // 'success' or the genuinely ambiguous 'unknown' both return
      // immediately — 'unknown' must never be retried via another
      // provider for the same double-charge-risk reason a timeout isn't.
      if (event && event.status !== 'failed') {
        return event;
      }
      if (event) declineMessage = event.error || `provider reported status '${event.status}'`;

      const next = fallbackOrder.find(c => !attemptedIds.has(c.id));
      if (!next || attempt >= MAX_ROUTING_ATTEMPTS) {
        // The cascade is exhausted. If the last attempt resolved with a
        // real (if declined) result, that IS the honest outcome to
        // return — not a thrown error masking a transaction that
        // actually completed (as declined) on every provider tried.
        if (event) return event;
        throw new Error(
          `Payment routing exhausted after ${attempt} attempt(s) [${Array.from(attemptedIds).join(' -> ')}]: last failure on '${currentProvider.config.name}' (${declineMessage}).`,
        );
      }
      const nextProvider = this.registry.getProvider(next.id)!;
      const verb = event ? 'declined' : 'failed';
      currentReason = `Dynamic Failover (cascading, attempt ${attempt + 1}/${Math.min(MAX_ROUTING_ATTEMPTS, fallbackOrder.length + 1)}): '${currentProvider.config.name}' ${verb} (${declineMessage}). Trying next-best-ranked '${nextProvider.config.name}'. | ${currentReason}`;
      currentProvider = nextProvider;
    }
  }

  // Capability-based messaging routing. Same precedence model as
  // routePayment above, with one addition ahead of everything except an
  // explicit providerOverride: conversation continuity (reusing the
  // provider an ongoing thread already used) — a routing rule or a
  // score-based pick must never silently switch providers mid-conversation.
  public async routeMessage(appId: string, payload: any): Promise<TransactionEvent> {
    const { recipient = '', content = '', providerOverride, tenantId = 'default' } = payload;
    // Phase 8: the gateway's VERIFIED supplier scope (never a body field —
    // resolveTenantContext strips those). Part of the conversation owner key.
    const supplierId: string | null = typeof payload.supplierId === 'string' && payload.supplierId ? payload.supplierId : null;
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    // Determined once, reused for consent checking, capability routing, and
    // conversation recording — previously recomputed inline in three places.
    const channel = recipient.includes('@') ? 'email'
      : content.toLowerCase().includes('wa:') || content.length > 300 ? 'whatsapp'
      : 'sms';

    // Consent: a STOP keyword blocks non-permitted outbound messaging on
    // this channel until the recipient opts back in (JOIN/START/HELP).
    // Fails open (allows the send) on a consent-store lookup error,
    // consistent with ConversationManager's existing best-effort pattern
    // in this same routing layer — a DB hiccup shouldn't take down all
    // outbound messaging. This is a real tradeoff (a genuinely opted-out
    // recipient could receive a message during a DB outage) surfaced via
    // console.error rather than swallowed silently; hardening it to
    // fail-closed is a documented follow-up, not done here.
    let optedOut = false;
    if (recipient) {
      try {
        optedOut = await consentRecordRepository.isOptedOut(appId, tenantId, recipient, channel);
      } catch (err: any) {
        console.error(`[routing] consent lookup failed for ${recipient} — failing open (send proceeds): ${err.message}`);
      }
    }
    if (optedOut) {
      throw new ConsentBlockedError(recipient, channel);
    }

    // P0 FIX: Check conversation history — now includes tenantId for isolation
    const conversationCtx: ConversationContext = { phoneNumber: recipient, appId, tenantId, supplierId };
    const conversation = await this.conversationManager.resolve(conversationCtx);

    if (conversation && !providerOverride) {
      const provider = this.registry.getProvider(conversation.providerId);
      if (provider && this.registry.isProviderAvailable(conversation.providerId)) {
        selectedProvider = provider;
        reason = `Conversation continuity: Reusing ${conversation.channel} provider '${provider.config.name}' for ${recipient}.`;
      }
    }

    const allProviders = this.registry.getAllConfigs();
    const activeMsg = allProviders.filter(
      p => p.category === 'messaging' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
    );

    if (activeMsg.length === 0 && !selectedProvider) {
      throw new Error('All messaging providers are currently OFFLINE / UNDER MAINTENANCE');
    }

    // 1. Manual override check
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (provider && this.registry.isProviderAvailable(providerOverride) && this.registry.isLiveEligible(providerOverride)) {
        selectedProvider = provider;
        reason = `Manual override matched: Forced messaging route to '${provider.config.name}'.`;
      } else {
        reason = `Override '${providerOverride}' unavailable or not production-eligible. Falling back. | `;
      }
    }

    // 2. Admin-configured routing rule (never overrides conversation
    // continuity above — see this method's class comment)
    if (!selectedProvider) {
      const ctx: RoutingContext = { channel };
      const rule = findMatchingRule(this.registry.getEnabledRoutingRules(), ctx);
      if (rule) {
        const provider = this.registry.getProvider(rule.target);
        if (provider && this.registry.isProviderAvailable(rule.target) && this.registry.isLiveEligible(rule.target)) {
          selectedProvider = provider;
          reason += `Routing rule matched ('${rule.match}'${rule.description ? ` — ${rule.description}` : ''}): routed to '${provider.config.name}'.`;
        } else {
          reason += `Routing rule matched ('${rule.match}') but target '${rule.target}' is offline/invalid. Falling back. | `;
        }
      }
    }

    // 3. Channel detection + success-rate/cost-scored capability routing.
    // Do NOT silently change a communication channel — every candidate
    // pool below is scoped to providers that declare the detected
    // channel's capability, matching the P1-4 fallback policy above.
    const channelCapability = channel === 'email' ? 'email' : channel === 'whatsapp' ? 'whatsapp' : 'sms';
    let ranked: RankedCandidate[] = rankByScore(
      this.registry.findByCategoryAndCapabilities('messaging', [channelCapability]),
    );

    if (!selectedProvider && ranked.length > 0) {
      const chosen = weightedRandomSelect(ranked, (c) => computeProviderScore(c));
      const provider = this.registry.getProvider(chosen.id);
      if (provider) {
        selectedProvider = provider;
        reason += `${channel} routing: candidates [${ranked.map(c => c.name).join(', ')}]. Selected '${chosen.name}' (error rate ${(chosen.errorRate ?? 0).toFixed(1)}%).`;
      }
    }

    if (!selectedProvider) {
      selectedProvider = this.registry.getProvider(activeMsg[0].id) || null;
      reason += `Defaulted to first available messaging channel: '${selectedProvider?.config.name}'.`;
    }

    if (!selectedProvider) {
      throw new Error('Routing failure: Unable to find a suitable online messaging provider.');
    }

    // Cascading waterfall across same-channel candidates, best-first by
    // score, up to MAX_ROUTING_ATTEMPTS total attempts. Unlike payments, a
    // messaging timeout is not treated as an ambiguous outcome worth
    // stopping the cascade for — resending a message carries none of a
    // duplicate-charge's real-money risk.
    const fallbackOrder = ranked.filter(c => c.id !== selectedProvider!.config.id);
    const attemptedIds = new Set<string>();
    let currentProvider = selectedProvider;
    let currentReason = reason;

    for (let attempt = 1; ; attempt++) {
      attemptedIds.add(currentProvider.config.id);
      try {
        // Phase 8: which business number this provider will send FROM, and
        // whether the recipient has opted out of that NUMBER (a STOP on a
        // shared number — see sender_opt_outs). Fails CLOSED: a lookup
        // error aborts the whole send (no cascade to another provider),
        // never a send past a possible STOP.
        const sender = await this.senderFor(appId, tenantId, supplierId, currentProvider, recipient);
        let senderOptedOut = false;
        if (sender.businessNumber && recipient) {
          try {
            senderOptedOut = await senderOptOutRepository.isOptedOut(sender.businessNumber, recipient, channel);
          } catch (lookupErr: any) {
            throw new SenderConsentLookupError(`sender-level consent lookup failed for ${sender.businessNumber}: ${lookupErr?.message}`);
          }
        }
        if (senderOptedOut) {
          // A STOP is not a provider failure: never cascade AROUND it to
          // another provider/number automatically. (A caller that genuinely
          // owns a different number may still send from it explicitly via
          // providerOverride.)
          throw new ConsentBlockedError(recipient, channel);
        }
        // P1: Wrap provider call with timeout to prevent hung requests
        const event = await withProviderTimeout(() => currentProvider!.processRequest(appId, payload, currentReason));
        // P2-8: Record conversation after successful delivery — on the
        // business number it was sent from (Phase 8).
        await this.conversationManager.record(conversationCtx, currentProvider.config.id, channel, sender);
        return event;
      } catch (err: any) {
        if (err instanceof ConsentBlockedError || err instanceof SenderConsentLookupError) throw err;
        const next = fallbackOrder.find(c => !attemptedIds.has(c.id))
          ?? (DEFAULT_FALLBACK_POLICY.allowAlternateProvider ? activeMsg.find(p => !attemptedIds.has(p.id)) : undefined);
        if (!next || attempt >= MAX_ROUTING_ATTEMPTS) {
          throw new Error(`Messaging dispatch failed on '${currentProvider.config.name}' (${err.message}) with no available failover routes.`);
        }
        const nextProvider = this.registry.getProvider(next.id)!;
        currentReason = `Dynamic Failover (cascading, attempt ${attempt + 1}): '${currentProvider.config.name}' failed (${err.message}). Switched to '${nextProvider.config.name}'. | ${currentReason}`;
        currentProvider = nextProvider;
      }
    }
  }

  /**
   * Phase 8: the business number an outbound send through `provider` goes
   * FROM, for recording on the conversation and for the sender-level STOP
   * check.
   *
   *  1. The adapter's own account-level sender (TWILIO_FROM_NUMBER etc.) is
   *     the truth when known — it is the number the provider actually uses
   *     (and, on a shared number, the same for every tenant). The owner's
   *     messaging profile for that sender, if any, is linked.
   *  2. Otherwise, the owner's registration for this provider: a profile
   *     dedicated to the sending supplier first, then a tenant-level one —
   *     used only when exactly one matches (several registrations, e.g. one
   *     per country, with no way to tell which the adapter will use, means
   *     the number is honestly left unrecorded rather than guessed).
   */
  private async senderFor(
    appId: string,
    tenantId: string,
    supplierId: string | null,
    provider: BaseProvider,
    recipient: string = '',
  ): Promise<ConversationSenderInfo> {
    const providerId = provider.config.id;
    const adapterSender = typeof provider.getSenderAddress === 'function' ? provider.getSenderAddress() : undefined;
    let profiles: Awaited<ReturnType<typeof messagingProfileRepository.findSendersForOwner>> = [];
    try {
      profiles = await messagingProfileRepository.findSendersForOwner(appId, tenantId, providerId);
    } catch (err: any) {
      // Same fail-open stance as the tenant-level consent lookup above (gap
      // register A7, still open): without the registry the number is only
      // known from the adapter itself. The sender-level STOP check below
      // still fails CLOSED whenever a number IS known.
      console.error(`[routing] messaging-profile lookup failed for ${appId}/${tenantId} via ${providerId}: ${err?.message}`);
    }
    const usable = profiles.filter((p) => !p.supplierId || p.supplierId === supplierId);
    if (adapterSender) {
      const normalized = normalizeMessagingAddress(adapterSender);
      const match = usable.find((p) => p.sender === normalized && p.supplierId === supplierId)
        ?? usable.find((p) => p.sender === normalized);
      return { businessNumber: normalized, messagingProfileId: match?.id ?? null, country: match?.country ?? null };
    }
    const supplierSpecific = supplierId ? usable.filter((p) => p.supplierId === supplierId) : [];
    let pool = supplierSpecific.length > 0 ? supplierSpecific : usable.filter((p) => !p.supplierId);
    if (pool.length > 1) {
      // One local number per country is the platform's model: prefer the
      // registration in the recipient's own country, when the number's
      // calling code identifies it unambiguously.
      const country = countryForE164(recipient);
      if (country) pool = pool.filter((p) => p.country.toUpperCase() === country);
    }
    if (pool.length === 1) {
      return { businessNumber: pool[0].sender, messagingProfileId: pool[0].id, country: pool[0].country };
    }
    return { businessNumber: null };
  }

  // Routes other API requests (Maps, Identity, AI)
  public async routeOther(appId: string, payload: any): Promise<TransactionEvent> {
    const { serviceType = 'maps', providerOverride } = payload;
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    const providerId = providerOverride || (serviceType === 'maps' ? 'maps' : serviceType === 'identity' ? 'identity' : 'ai');
    const provider = this.registry.getProvider(providerId);

    if (provider && this.registry.isProviderAvailable(providerId) && this.registry.isLiveEligible(providerId)) {
      selectedProvider = provider;
      reason = `Routed to designated API node '${provider.config.name}' for service type '${serviceType}'.`;
    } else {
      const allProviders = this.registry.getAllConfigs();
      const backups = allProviders.filter(
        p => p.category === 'other' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
      );
      if (backups.length > 0) {
        selectedProvider = this.registry.getProvider(backups[0].id) || null;
        reason = `Designated provider '${providerId}' was offline. Routed to backup services node '${selectedProvider?.config.name}'.`;
      }
    }

    if (!selectedProvider) {
      throw new Error(`Routing failure: Service node for '${serviceType}' is offline.`);
    }

    // P1: Wrap provider call with timeout to prevent hung requests
    return await withProviderTimeout(
      () => selectedProvider!.processRequest(appId, payload, reason),
    );
  }
}
