import { randomUUID } from 'node:crypto';
import { ProviderConfig, TransactionEvent } from '@company/schemas';
import { ProviderRegistry, BaseProvider } from '@company/providers';
import { consentRecordRepository } from '@company/database';
import { ConversationManager, ConversationContext } from './conversation';

export { ConversationManager, type ConversationContext } from './conversation';
export { ConversationResolver, type ConversationResolution } from './conversation-resolver';
export { handleKeyword, type KeywordContext, type KeywordResult } from './keywords';

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
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 30_000;

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
  public async routePayment(appId: string, payload: any): Promise<TransactionEvent> {
    const { currency = 'USD', paymentMethod = 'card', providerOverride } = payload;
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    const allProviders = this.registry.getAllConfigs();
    const activePayments = allProviders.filter(
      p => p.category === 'payment' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
    );

    if (activePayments.length === 0) {
      throw new Error('All payment providers are currently OFFLINE / UNDER MAINTENANCE');
    }

    // 1. Check for manual override
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (provider && this.registry.isProviderAvailable(providerOverride) && this.registry.isLiveEligible(providerOverride)) {
        selectedProvider = provider;
        reason = `Manual override matched: Forced routing to '${provider.config.name}'.`;
      } else {
        reason = `Manual override '${providerOverride}' requested but provider is offline/invalid/not production-eligible. Falling back. | `;
      }
    }

    // 2. Capability-based routing: find providers that support the currency + payment method
    if (!selectedProvider) {
      const cur = currency.toUpperCase();
      const capabilities = [paymentMethod];

      // For mobile money in East/West Africa, also check mobile_money capability
      if (paymentMethod === 'mobile_money') {
        capabilities.push('mobile_money');
      }

      const candidates = this.registry.findByCategoryAndCapabilities('payment', capabilities, cur);

      if (candidates.length > 0) {
        // Weight-based selection among capability-matched providers
        const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
        let random = Math.random() * totalWeight;
        let chosen = candidates[0];

        for (const c of candidates) {
          random -= c.weight;
          if (random <= 0) {
            chosen = c;
            break;
          }
        }

        const provider = this.registry.getProvider(chosen.id);
        if (provider) {
          selectedProvider = provider;
          reason = `Capability-based routing: Matched providers [${candidates.map(c => c.name).join(', ')}] for ${cur}/${paymentMethod}. Selected '${chosen.name}' (weight ${chosen.weight}/${totalWeight}).`;
        }
      }

      // Fallback: if no capability match, use global weight-based routing
      if (!selectedProvider) {
        const candidates = activePayments.filter(p => ['stripe', 'nmi', 'airwallex'].includes(p.id));

        if (candidates.length > 0) {
          const totalWeight = candidates.reduce((sum, p) => sum + p.weight, 0);
          let random = Math.random() * totalWeight;
          let chosenConfig: ProviderConfig | null = null;

          for (const c of candidates) {
            random -= c.weight;
            if (random <= 0) {
              chosenConfig = c;
              break;
            }
          }

          if (chosenConfig) {
            selectedProvider = this.registry.getProvider(chosenConfig.id) || null;
            reason += `Global weight allocation fallback. Chosen: '${selectedProvider?.config.name}' (weight ${chosenConfig.weight}/${totalWeight}).`;
          }
        }
      }
    }

    if (!selectedProvider) {
      throw new Error('Routing failure: Unable to find a suitable online payment provider.');
    }

    try {
      // P1: Wrap provider call with timeout to prevent hung requests
      return await withProviderTimeout(
        () => selectedProvider!.processRequest(appId, payload, reason),
      );
    } catch (err: any) {
      // P0: A payment timeout is ambiguous — the provider may have received
      // and even completed the charge before the response was lost. Never
      // treat that the same as a confirmed failure: retrying the same
      // payment through a second provider here would risk a real double
      // charge on money we don't know the status of. Surface it as its own
      // 'unknown' outcome instead — the caller must persist it as pending
      // reconciliation (via webhook or a status check against the
      // provider), not silently resolve it either way.
      if (err instanceof ProviderTimeoutError) {
        return {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          appId,
          category: 'payment',
          providerId: selectedProvider.config.id,
          status: 'unknown',
          amount: Number(payload.amount),
          currency,
          latency: PROVIDER_TIMEOUT_MS,
          cost: 0,
          decisionReason: `${reason} | Ambiguous outcome: ${err.message}. Not retried via another provider — outcome must be reconciled via webhook/status check before any further action.`,
          payload,
          response: null,
          error: err.message,
        };
      }

      // Any other error (e.g. the provider rejected the request outright,
      // or went offline in the race between selection and dispatch) is
      // safe to treat as "never processed" and failover.
      const nextProviderConfig = activePayments.find(p => p.id !== selectedProvider!.config.id);
      if (nextProviderConfig) {
        const nextProvider = this.registry.getProvider(nextProviderConfig.id)!;
        const fallbackReason = `Dynamic Failover: Primary '${selectedProvider.config.name}' failed (${err.message}). Re-routing to secondary '${nextProvider.config.name}'. Original Reason: ${reason}`;
        return await withProviderTimeout(
          () => nextProvider.processRequest(appId, payload, fallbackReason),
        );
      } else {
        throw new Error(`Primary route '${selectedProvider.config.name}' failed (${err.message}) and no fallback options are available.`);
      }
    }
  }

  // Capability-based messaging routing
  public async routeMessage(appId: string, payload: any): Promise<TransactionEvent> {
    const { recipient = '', content = '', providerOverride, tenantId = 'default' } = payload;
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
    const conversationCtx: ConversationContext = { phoneNumber: recipient, appId, tenantId };
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

    // 2. Channel detection + capability-based routing
    if (!selectedProvider) {
      const isEmail = channel === 'email';
      const isWhatsapp = channel === 'whatsapp';

      if (isEmail) {
        const candidates = this.registry.findByCategoryAndCapabilities('messaging', ['email']);
        if (candidates.length > 0) {
          selectedProvider = this.registry.getProvider(candidates[0].id) || null;
          reason += `Email address format detected. Capability-based routing to '${selectedProvider?.config.name}'.`;
        }
      } else if (isWhatsapp) {
        const candidates = this.registry.findByCategoryAndCapabilities('messaging', ['whatsapp']);
        if (candidates.length > 0) {
          selectedProvider = this.registry.getProvider(candidates[0].id) || null;
          reason += `WhatsApp format detected. Capability-based routing to '${selectedProvider?.config.name}'.`;
        }
      } else {
        // SMS routing: try capability-based, then fallback to first available
        const candidates = this.registry.findByCategoryAndCapabilities('messaging', ['sms']);
        if (candidates.length > 0) {
          // Weight-based selection among SMS-capable providers
          const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
          let random = Math.random() * totalWeight;
          let chosen = candidates[0];

          for (const c of candidates) {
            random -= c.weight;
            if (random <= 0) {
              chosen = c;
              break;
            }
          }

          selectedProvider = this.registry.getProvider(chosen.id) || null;
          reason += `SMS routing: Matched providers [${candidates.map(c => c.name).join(', ')}]. Selected '${chosen.name}'.`;
        }
      }
    }

    if (!selectedProvider) {
      selectedProvider = this.registry.getProvider(activeMsg[0].id) || null;
      reason += `Defaulted to first available messaging channel: '${selectedProvider?.config.name}'.`;
    }

    if (!selectedProvider) {
      throw new Error('Routing failure: Unable to find a suitable online messaging provider.');
    }

    try {
      // P1: Wrap provider call with timeout to prevent hung requests
      const event = await withProviderTimeout(
        () => selectedProvider!.processRequest(appId, payload, reason),
      );
      // P2-8: Record conversation after successful delivery
      await this.conversationManager.record(conversationCtx, selectedProvider.config.id, channel);
      return event;
    } catch (err: any) {
      // P1-4: Respect channel fallback policy.
      // Do NOT silently change a communication channel — only failover
      // to alternate providers of the same channel type.
      const fallbackConfig = activeMsg.find(p => p.id !== selectedProvider!.config.id);
      if (fallbackConfig && DEFAULT_FALLBACK_POLICY.allowAlternateProvider) {
        const nextProvider = this.registry.getProvider(fallbackConfig.id)!;
        return await withProviderTimeout(
          () => nextProvider.processRequest(
            appId,
            payload,
            `Dynamic Failover: Primary '${selectedProvider.config.name}' failed (${err.message}). Switched to '${nextProvider.config.name}'.`,
          ),
        );
      } else {
        throw new Error(`Messaging dispatch failed on '${selectedProvider.config.name}' (${err.message}) with no available failover routes.`);
      }
    }
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
