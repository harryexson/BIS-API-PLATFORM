import { ProviderConfig, TransactionEvent } from '@company/schemas';
import { ProviderRegistry, BaseProvider } from '@company/providers';

export class RoutingEngine {
  private registry: ProviderRegistry;

  constructor() {
    this.registry = ProviderRegistry.getInstance();
  }

  // Routes a payment request
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

    // 2. Routing Rules
    if (!selectedProvider) {
      const cur = currency.toUpperCase();
      
      if (cur === 'MWK') {
        const payChangu = this.registry.getProvider('paychangu');
        if (payChangu && payChangu.config.status === 'online') {
          selectedProvider = payChangu;
          reason += `Malawi Kwacha currency detected. Routed to native gateway PayChangu.`;
        } else {
          const flw = this.registry.getProvider('flutterwave');
          if (flw && flw.config.status === 'online') {
            selectedProvider = flw;
            reason += `PayChangu offline. Falling back to Flutterwave (supports international settlement for MWK).`;
          } else {
            reason += `PayChangu and Flutterwave offline. Attempting general payment routing. | `;
          }
        }
      }
      
      else if (['KES', 'UGX', 'GHS', 'TZS'].includes(cur) && paymentMethod === 'mobile_money') {
        const pawapay = this.registry.getProvider('pawapay');
        if (pawapay && pawapay.config.status === 'online') {
          selectedProvider = pawapay;
          reason += `Mobile Money method for East/West African currency (${cur}) detected. Routed to PawaPay.`;
        } else {
          const flw = this.registry.getProvider('flutterwave');
          if (flw && flw.config.status === 'online') {
            selectedProvider = flw;
            reason += `PawaPay offline. Falling back to Flutterwave Mobile Money rails.`;
          } else {
            reason += `Mobile Money channels offline. Attempting card payment rails. | `;
          }
        }
      }
      
      else if (['NGN', 'GHS', 'ZAR', 'KES'].includes(cur) && paymentMethod === 'card') {
        const flw = this.registry.getProvider('flutterwave');
        if (flw && flw.config.status === 'online') {
          selectedProvider = flw;
          reason += `African card transaction (${cur}) detected. Routed to Flutterwave.`;
        } else {
          const airwallex = this.registry.getProvider('airwallex');
          if (airwallex && airwallex.config.status === 'online') {
            selectedProvider = airwallex;
            reason += `Flutterwave offline. Falling back to Airwallex international regional cards.`;
          } else {
            reason += `Flutterwave and Airwallex offline. Attempting global processors. | `;
          }
        }
      }
    }

    // 3. Global Cards / Weight-based Routing (Stripe vs NMI)
    if (!selectedProvider) {
      const candidates = activePayments.filter(p => ['stripe', 'nmi', 'airwallex'].includes(p.id));
      
      if (candidates.length === 0) {
        selectedProvider = this.registry.getProvider(activePayments[0].id) || null;
        reason += `No primary global route online. Picked first available: '${selectedProvider?.config.name}'.`;
      } else {
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
          reason += `Routed via global weight allocation (Stripe/NMI/Airwallex). Chosen: '${selectedProvider?.config.name}' (weight ${chosenConfig.weight}/${totalWeight}).`;
        }
      }
    }

    if (!selectedProvider) {
      throw new Error('Routing failure: Unable to find a suitable online payment provider.');
    }

    try {
      return await selectedProvider.processRequest(appId, payload, reason);
    } catch (err: any) {
      const nextProviderConfig = activePayments.find(p => p.id !== selectedProvider!.config.id);
      if (nextProviderConfig) {
        const nextProvider = this.registry.getProvider(nextProviderConfig.id)!;
        const fallbackReason = `Dynamic Failover: Primary '${selectedProvider.config.name}' failed (${err.message}). Re-routing to secondary '${nextProvider.config.name}'. Original Reason: ${reason}`;
        return await nextProvider.processRequest(appId, payload, fallbackReason);
      } else {
        throw new Error(`Primary route '${selectedProvider.config.name}' failed (${err.message}) and no fallback options are available.`);
      }
    }
  }

  // Routes a messaging request
  public async routeMessage(appId: string, payload: any): Promise<TransactionEvent> {
    const { recipient = '', content = '', providerOverride } = payload;
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    const allProviders = this.registry.getAllConfigs();
    const activeMsg = allProviders.filter(p => p.category === 'messaging' && p.status === 'online');

    if (activeMsg.length === 0) {
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

    // 2. Channel logic
    if (!selectedProvider) {
      const isEmail = recipient.includes('@');
      
      if (isEmail) {
        const email = this.registry.getProvider('email');
        if (email && email.config.status === 'online') {
          selectedProvider = email;
          reason += `Email address format detected. Routed to Email SMTP Gateway.`;
        } else {
          const sh = this.registry.getProvider('signalhouse');
          if (sh && sh.config.status === 'online') {
            selectedProvider = sh;
            reason += `Email SMTP offline. Falling back to SignalHouse Multi-Channel email dispatch.`;
          }
        }
      } else {
        const isWhatsapp = content.toLowerCase().includes('wa:') || content.length > 300;
        
        if (isWhatsapp) {
          const sh = this.registry.getProvider('signalhouse');
          if (sh && sh.config.status === 'online') {
            selectedProvider = sh;
            reason += `Rich push / WhatsApp format detected. Routed to SignalHouse.`;
          }
        }
        
        if (!selectedProvider) {
          const infobip = this.registry.getProvider('infobip');
          const futuresms = this.registry.getProvider('futuresms');
          
          if (futuresms && futuresms.config.status === 'online' && (recipient.startsWith('+254') || recipient.startsWith('+265') || futuresms.config.weight > 60)) {
            selectedProvider = futuresms;
            reason += `Routed to Future SMS budget gateway (regional target or high weight rule matched).`;
          } else if (infobip && infobip.config.status === 'online') {
            selectedProvider = infobip;
            reason += `Routed to Infobip Enterprise SMS (high reliability default).`;
          } else if (futuresms && futuresms.config.status === 'online') {
            selectedProvider = futuresms;
            reason += `Infobip offline. Routed to Future SMS budget carrier fallback.`;
          } else {
            const sh = this.registry.getProvider('signalhouse');
            if (sh && sh.config.status === 'online') {
              selectedProvider = sh;
              reason += `All SMS carriers offline. Falling back to SignalHouse WhatsApp proxy.`;
            }
          }
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
      return await selectedProvider.processRequest(appId, payload, reason);
    } catch (err: any) {
      const fallbackConfig = activeMsg.find(p => p.id !== selectedProvider!.config.id);
      if (fallbackConfig) {
        const nextProvider = this.registry.getProvider(fallbackConfig.id)!;
        return await nextProvider.processRequest(
          appId,
          payload,
          `Dynamic Failover: Primary '${selectedProvider.config.name}' failed (${err.message}). Switched to '${nextProvider.config.name}'.`
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

    return await selectedProvider.processRequest(appId, payload, reason);
  }
}
