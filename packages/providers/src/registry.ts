import { ProviderConfig } from '@company/schemas';
import { BaseProvider } from './base';

import { StripeProvider } from './adapters/payments/stripe';
import { NMIProvider } from './adapters/payments/nmi';
import { FlutterwaveProvider } from './adapters/payments/flutterwave';
import { PawaPayProvider } from './adapters/payments/pawapay';
import { PayChanguProvider } from './adapters/payments/paychangu';
import { AirwallexProvider } from './adapters/payments/airwallex';

import { SignalHouseProvider } from './adapters/messaging/signalhouse';
import { InfobipProvider } from './adapters/messaging/infobip';
import { FutureSMSProvider } from './adapters/messaging/futuresms';
import { EmailProvider } from './adapters/messaging/email';

import { MapsProvider } from './adapters/other/maps';
import { IdentityProvider } from './adapters/other/identity';
import { AIProvider } from './adapters/other/ai';

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, BaseProvider> = new Map();

  private constructor() {
    this.initializeProviders();
  }

  public static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  private initializeProviders() {
    this.register(new StripeProvider({
      id: 'stripe',
      name: 'Stripe',
      category: 'payment',
      status: 'online',
      weight: 70,
      latencyMin: 120,
      latencyMax: 160,
      transactionFeePercent: 2.9,
      transactionFeeFlat: 0.30
    }));

    this.register(new NMIProvider({
      id: 'nmi',
      name: 'NMI',
      category: 'payment',
      status: 'online',
      weight: 30,
      latencyMin: 140,
      latencyMax: 190,
      transactionFeePercent: 2.2,
      transactionFeeFlat: 0.20
    }));

    this.register(new FlutterwaveProvider({
      id: 'flutterwave',
      name: 'Flutterwave',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 200,
      latencyMax: 260,
      transactionFeePercent: 1.4,
      transactionFeeFlat: 0.0
    }));

    this.register(new PawaPayProvider({
      id: 'pawapay',
      name: 'PawaPay',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 220,
      latencyMax: 280,
      transactionFeePercent: 1.0,
      transactionFeeFlat: 0.0
    }));

    this.register(new PayChanguProvider({
      id: 'paychangu',
      name: 'PayChangu',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 250,
      latencyMax: 320,
      transactionFeePercent: 1.5,
      transactionFeeFlat: 0.0
    }));

    this.register(new AirwallexProvider({
      id: 'airwallex',
      name: 'Airwallex',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 160,
      latencyMax: 220,
      transactionFeePercent: 2.0,
      transactionFeeFlat: 0.0
    }));

    this.register(new SignalHouseProvider({
      id: 'signalhouse',
      name: 'SignalHouse',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 80,
      latencyMax: 120,
      messageCost: 0.005
    }));

    this.register(new InfobipProvider({
      id: 'infobip',
      name: 'Infobip',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 90,
      latencyMax: 140,
      messageCost: 0.008
    }));

    this.register(new FutureSMSProvider({
      id: 'futuresms',
      name: 'Future SMS',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 180,
      latencyMax: 250,
      messageCost: 0.002
    }));

    this.register(new EmailProvider({
      id: 'email',
      name: 'Email SMTP',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 130,
      latencyMax: 180,
      messageCost: 0.0001
    }));

    this.register(new MapsProvider({
      id: 'maps',
      name: 'Google Maps API',
      category: 'other',
      status: 'online',
      weight: 50,
      latencyMin: 100,
      latencyMax: 150
    }));

    this.register(new IdentityProvider({
      id: 'identity',
      name: 'Identity API',
      category: 'other',
      status: 'online',
      weight: 50,
      latencyMin: 60,
      latencyMax: 100
    }));

    this.register(new AIProvider({
      id: 'ai',
      name: 'Gemini AI API',
      category: 'other',
      status: 'online',
      weight: 50,
      latencyMin: 300,
      latencyMax: 600
    }));
  }

  private register(provider: BaseProvider) {
    this.providers.set(provider.config.id, provider);
  }

  public getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  public getAllConfigs(): ProviderConfig[] {
    return Array.from(this.providers.values()).map(p => p.config);
  }

  public updateProviderConfig(id: string, updates: Partial<ProviderConfig>): ProviderConfig | null {
    const provider = this.providers.get(id);
    if (!provider) return null;

    provider.config = {
      ...provider.config,
      ...updates
    };
    return provider.config;
  }
}
