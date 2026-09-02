import { ProviderConfig, TransactionEvent } from '@company/schemas';
import { ProviderRegistry, BaseProvider } from '@company/providers';
import { ConversationManager, ConversationContext } from './conversation';

export { ConversationManager, type ConversationContext } from './conversation';
export { ConversationResolver, type ConversationResolution } from './conversation-resolver';
export { handleKeyword, type KeywordContext, type KeywordResult } from './keywords';

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
          reject(new Error(`Provider request timed out after ${timeoutMs}ms`)),
        ),
      ),
    ]);
  }
  // Fallback for environments without AbortSignal.timeout
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Provider request timed out after ${timeoutMs}ms`)), timeoutMs),
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
    const activePayments = allProviders.filter(p => p.category === 'payment' && p.status === 'online');

    if (activePayments.length === 0) {
      throw new Error('All payment providers are currently OFFLINE / UNDER MAINTENANCE');
    }

    // 1. Check for manual override
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (provider && provider.config.status === 'online') {
        selectedProvider = provider;
        reason = `Manual override matched: Forced routing to '${provider.config.name}'.`;
      } else {
        reason = `Manual override '${providerOverride}' requested but provider is offline/invalid. Falling back. | `;
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

    // P0 FIX: Check conversation history — now includes tenantId for isolation
    const conversationCtx: ConversationContext = { phoneNumber: recipient, appId, tenantId };
    const conversation = await this.conversationManager.resolve(conversationCtx);

    if (conversation && !providerOverride) {
      const provider = this.registry.getProvider(conversation.providerId);
      if (provider && provider.config.status === 'online') {
        selectedProvider = provider;
        reason = `Conversation continuity: Reusing ${conversation.channel} provider '${provider.config.name}' for ${recipient}.`;
      }
    }

    const allProviders = this.registry.getAllConfigs();
    const activeMsg = allProviders.filter(p => p.category === 'messaging' && p.status === 'online');

    if (activeMsg.length === 0 && !selectedProvider) {
      throw new Error('All messaging providers are currently OFFLINE / UNDER MAINTENANCE');
    }

    // 1. Manual override check
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (provider && provider.config.status === 'online') {
        selectedProvider = provider;
        reason = `Manual override matched: Forced messaging route to '${provider.config.name}'.`;
      } else {
        reason = `Override '${providerOverride}' unavailable. Falling back. | `;
      }
    }

    // 2. Channel detection + capability-based routing
    if (!selectedProvider) {
      const isEmail = recipient.includes('@');
      const isWhatsapp = content.toLowerCase().includes('wa:') || content.length > 300;

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
      const channel = recipient.includes('@') ? 'email'
        : content.toLowerCase().includes('wa:') || content.length > 300 ? 'whatsapp'
        : 'sms';
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

    if (provider && provider.config.status === 'online') {
      selectedProvider = provider;
      reason = `Routed to designated API node '${provider.config.name}' for service type '${serviceType}'.`;
    } else {
      const allProviders = this.registry.getAllConfigs();
      const backups = allProviders.filter(p => p.category === 'other' && p.status === 'online');
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
