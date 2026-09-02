import {
  ProviderConfig,
  ProviderManagement,
  ProviderEnvironment,
  ProviderHealthStatus,
  ProviderSecretMeta,
  ProviderCapabilityMatch,
  RoutingRule,
  HealthCheckSummary,
} from '@company/schemas';
import { randomUUID } from 'crypto';
import { BaseProvider } from './base';

import { StripeProvider } from './adapters/payments/stripe';
import { NMIProvider } from './adapters/payments/nmi';
import { FlutterwaveProvider } from './adapters/payments/flutterwave';
import { PawaPayProvider } from './adapters/payments/pawapay';
import { PayChanguProvider } from './adapters/payments/paychangu';
import { AirwallexProvider } from './adapters/payments/airwallex';
import { ExamplePaymentProvider } from './adapters/payments/example';

import { SignalHouseProvider } from './adapters/messaging/signalhouse';
import { InfobipProvider } from './adapters/messaging/infobip';
import { FutureSMSProvider } from './adapters/messaging/futuresms';
import { EmailProvider } from './adapters/messaging/email';
import { ExampleMessagingProvider } from './adapters/messaging/example';

import { MapsProvider } from './adapters/other/maps';
import { IdentityProvider } from './adapters/other/identity';
import { AIProvider } from './adapters/other/ai';

// A stored secret keeps the plaintext value private to the registry.
// Only masked metadata is ever returned to callers.
interface StoredSecret {
  meta: ProviderSecretMeta;
  value: string;
}

export interface ManagementState {
  environment: ProviderEnvironment;
  countries: string[];
  currencies: string[];
  capabilities: string[];
  priority: number;
  health: ProviderHealthStatus;
  lastSuccessfulRequest: string | null;
  errorRate: number;
  routingRules: RoutingRule[];
  secrets: StoredSecret[];
}

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, BaseProvider> = new Map();
  private management: Map<string, ManagementState> = new Map();

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
    }), { environment: 'live', countries: ['*'], currencies: ['USD', 'EUR', 'GBP'], capabilities: ['card'] });

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
    }), { environment: 'live', countries: ['US', 'CA'], currencies: ['USD', 'CAD'], capabilities: ['card'] });

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
    }), { environment: 'live', countries: ['NG', 'GH', 'KE'], currencies: ['NGN', 'GHS', 'KES', 'USD'], capabilities: ['card', 'mobile_money'] });

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
    }), { environment: 'live', countries: ['MW', 'ZM', 'TZ', 'UG'], currencies: ['MWK', 'ZMW', 'TZS', 'UGX'], capabilities: ['mobile_money'] });

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
    }), { environment: 'test', countries: ['MW'], currencies: ['MWK', 'USD'], capabilities: ['mobile_money', 'card'] });

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
    }), { environment: 'live', countries: ['*'], currencies: ['USD', 'EUR', 'HKD', 'SGD'], capabilities: ['card', 'bank_transfer'] });

    this.register(new SignalHouseProvider({
      id: 'signalhouse',
      name: 'SignalHouse',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 80,
      latencyMax: 120,
      messageCost: 0.005
    }), { environment: 'live', countries: ['MW'], currencies: ['MWK'], capabilities: ['sms'] });

    this.register(new InfobipProvider({
      id: 'infobip',
      name: 'Infobip',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 90,
      latencyMax: 140,
      messageCost: 0.008
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['sms', 'whatsapp'] });

    this.register(new FutureSMSProvider({
      id: 'futuresms',
      name: 'Future SMS',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 180,
      latencyMax: 250,
      messageCost: 0.002
    }), { environment: 'live', countries: ['MW', 'ZM'], currencies: ['MWK', 'ZMW'], capabilities: ['sms'] });

    this.register(new EmailProvider({
      id: 'email',
      name: 'Email SMTP',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 130,
      latencyMax: 180,
      messageCost: 0.0001
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['email'] });

    this.register(new MapsProvider({
      id: 'maps',
      name: 'Google Maps API',
      category: 'other',
      status: 'online',
      weight: 50,
      latencyMin: 100,
      latencyMax: 150
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['geocoding', 'routes'] });

    this.register(new IdentityProvider({
      id: 'identity',
      name: 'Identity API',
      category: 'other',
      status: 'online',
      weight: 50,
      latencyMin: 60,
      latencyMax: 100
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['kyc', 'verification'] });

    this.register(new AIProvider({
      id: 'ai',
      name: 'Gemini AI API',
      category: 'other',
      status: 'online',
      weight: 50,
      latencyMin: 300,
      latencyMax: 600
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['completion', 'embeddings'] });

    // ----------------------------------------------------
    // EXAMPLE PROVIDERS (demonstrate provider extensibility)
    // ----------------------------------------------------
    // Adding a new provider only requires: adapter class + registration here.
    // No routing engine changes needed — capability-based routing handles it.

    this.register(new ExamplePaymentProvider({
      id: 'example-pay',
      name: 'Example Payment Gateway',
      category: 'payment',
      status: 'online',
      weight: 25,
      latencyMin: 100,
      latencyMax: 200,
      transactionFeePercent: 2.5,
      transactionFeeFlat: 0.0
    }), { environment: 'test', countries: ['*'], currencies: ['USD', 'EUR'], capabilities: ['card'] });

    this.register(new ExampleMessagingProvider({
      id: 'example-msg',
      name: 'Example Messaging Gateway',
      category: 'messaging',
      status: 'online',
      weight: 25,
      latencyMin: 70,
      latencyMax: 130,
      messageCost: 0.003
    }), { environment: 'test', countries: ['*'], currencies: ['USD'], capabilities: ['sms', 'email'] });
  }

  private register(provider: BaseProvider, managementDefaults: {
    environment: ProviderEnvironment;
    countries: string[];
    currencies: string[];
    capabilities: string[];
  }) {
    this.providers.set(provider.config.id, provider);
    const id = provider.config.id;
    const generated = 'sk_' + randomUUID().replace(/-/g, '').slice(0, 32);
    this.management.set(id, {
      environment: managementDefaults.environment,
      countries: managementDefaults.countries,
      currencies: managementDefaults.currencies,
      capabilities: managementDefaults.capabilities,
      priority: provider.config.weight,
      health: 'unknown',
      lastSuccessfulRequest: null,
      errorRate: 0,
      routingRules: [],
      secrets: [{
        meta: {
          id: `${id}_api_key`,
          label: 'API Key',
          masked: this.maskSecret(generated),
          lastUpdated: new Date().toISOString()
        },
        value: generated
      }]
    });
  }

  public getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  public getAllConfigs(): ProviderConfig[] {
    return Array.from(this.providers.values()).map(p => p.config);
  }

  // Capability-based routing: find providers by category + required capabilities + supported currencies
  public findByCategoryAndCapabilities(
    category: 'payment' | 'messaging' | 'other',
    requiredCapabilities: string[],
    currency?: string,
  ): ProviderCapabilityMatch[] {
    const matches: ProviderCapabilityMatch[] = [];

    for (const [id, provider] of this.providers) {
      const config = provider.config;
      if (config.category !== category) continue;
      if (config.status !== 'online') continue;

      const state = this.management.get(id);
      if (!state) continue;

      // Check that provider supports all required capabilities
      const hasAllCapabilities = requiredCapabilities.every(cap =>
        state.capabilities.includes(cap)
      );
      if (!hasAllCapabilities) continue;

      // Check currency support if specified
      if (currency) {
        const cur = currency.toUpperCase();
        if (!state.currencies.includes(cur) && !state.currencies.includes('*')) continue;
      }

      matches.push({
        id,
        name: config.name,
        category: config.category,
        capabilities: state.capabilities,
        currencies: state.currencies,
        countries: state.countries,
        weight: config.weight,
        status: config.status,
      });
    }

    // Sort by weight descending
    matches.sort((a, b) => b.weight - a.weight);
    return matches;
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

  // ----------------------------------------------------
  // MANAGEMENT SURFACE
  // ----------------------------------------------------

  public getManagementView(id: string): ProviderManagement | null {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state) return null;

    return {
      ...provider.config,
      environment: state.environment,
      countries: state.countries,
      currencies: state.currencies,
      capabilities: state.capabilities,
      priority: state.priority,
      health: state.health,
      lastSuccessfulRequest: state.lastSuccessfulRequest,
      errorRate: state.errorRate,
      routingRules: state.routingRules
    };
  }

  public getAllManagementViews(): ProviderManagement[] {
    return Array.from(this.providers.keys())
      .map(id => this.getManagementView(id))
      .filter((v): v is ProviderManagement => v !== null);
  }

  public updateManagement(
    id: string,
    updates: Partial<Omit<ProviderManagement, 'id' | 'name' | 'category'>>
  ): ProviderManagement | null {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state) return null;

    if (updates.weight !== undefined) {
      provider.config.weight = updates.weight;
    }
    if (updates.priority !== undefined) {
      state.priority = updates.priority;
      provider.config.weight = updates.priority;
    }
    if (updates.status !== undefined) {
      provider.config.status = updates.status;
    }
    if (updates.latencyMin !== undefined) {
      provider.config.latencyMin = updates.latencyMin;
    }
    if (updates.latencyMax !== undefined) {
      provider.config.latencyMax = updates.latencyMax;
    }
    if (updates.transactionFeePercent !== undefined) {
      provider.config.transactionFeePercent = updates.transactionFeePercent;
    }
    if (updates.transactionFeeFlat !== undefined) {
      provider.config.transactionFeeFlat = updates.transactionFeeFlat;
    }
    if (updates.messageCost !== undefined) {
      provider.config.messageCost = updates.messageCost;
    }

    if (updates.environment !== undefined) state.environment = updates.environment;
    if (updates.countries !== undefined) state.countries = updates.countries;
    if (updates.currencies !== undefined) state.currencies = updates.currencies;
    if (updates.capabilities !== undefined) state.capabilities = updates.capabilities;
    if (updates.priority !== undefined) state.priority = updates.priority;
    if (updates.health !== undefined) state.health = updates.health;
    if (updates.lastSuccessfulRequest !== undefined) state.lastSuccessfulRequest = updates.lastSuccessfulRequest;
    if (updates.errorRate !== undefined) state.errorRate = updates.errorRate;
    if (updates.routingRules !== undefined) state.routingRules = updates.routingRules;

    return this.getManagementView(id);
  }

  // ----------------------------------------------------
  // SECRETS (metadata only — plaintext is never exposed)
  // ----------------------------------------------------

  private maskSecret(value: string): string {
    const visible = value.slice(0, Math.min(6, Math.max(0, value.length - 4)));
    const tail = value.slice(-4);
    return `${visible}${'•'.repeat(10)}${tail}`;
  }

  public getSecrets(id: string): ProviderSecretMeta[] | null {
    const state = this.management.get(id);
    if (!state) return null;
    return state.secrets.map(s => s.meta);
  }

  public addSecret(
    id: string,
    input: { label: string; value: string }
  ): ProviderSecretMeta | null {
    const state = this.management.get(id);
    if (!state) return null;

    const meta: ProviderSecretMeta = {
      id: 'sec_' + randomUUID().replace(/-/g, '').slice(0, 12),
      label: input.label,
      masked: this.maskSecret(input.value),
      lastUpdated: new Date().toISOString()
    };
    state.secrets.push({ meta, value: input.value });
    return meta;
  }

  public deleteSecret(id: string, secretId: string): boolean {
    const state = this.management.get(id);
    if (!state) return false;
    const before = state.secrets.length;
    state.secrets = state.secrets.filter(s => s.meta.id !== secretId);
    return state.secrets.length < before;
  }

  // ----------------------------------------------------
  // ROUTING RULES
  // ----------------------------------------------------

  public getRoutingRules(id: string): RoutingRule[] | null {
    const state = this.management.get(id);
    if (!state) return null;
    return state.routingRules;
  }

  public addRoutingRule(id: string, rule: Omit<RoutingRule, 'id'>): RoutingRule | null {
    const state = this.management.get(id);
    if (!state) return null;

    const created: RoutingRule = {
      ...rule,
      id: 'rule_' + randomUUID().replace(/-/g, '').slice(0, 12)
    };
    state.routingRules.push(created);
    return created;
  }

  public updateRoutingRule(
    id: string,
    ruleId: string,
    updates: Partial<Omit<RoutingRule, 'id'>>
  ): RoutingRule | null {
    const state = this.management.get(id);
    if (!state) return null;

    const rule = state.routingRules.find(r => r.id === ruleId);
    if (!rule) return null;

    Object.assign(rule, updates);
    return rule;
  }

  public deleteRoutingRule(id: string, ruleId: string): boolean {
    const state = this.management.get(id);
    if (!state) return false;
    const before = state.routingRules.length;
    state.routingRules = state.routingRules.filter(r => r.id !== ruleId);
    return state.routingRules.length < before;
  }

  // ----------------------------------------------------
  // HEALTH CHECKS
  // ----------------------------------------------------

  // Updates rolling error rate and last successful request based on live traffic.
  public recordTraffic(id: string, success: boolean, latencyMs: number): void {
    const state = this.management.get(id);
    if (!state) return;

    if (success) {
      state.lastSuccessfulRequest = new Date().toISOString();
      state.errorRate = Math.round(state.errorRate * 0.9 * 10) / 10;
    } else {
      state.errorRate = Math.min(100, Math.round((state.errorRate * 0.9 + 10) * 10) / 10);
    }

    if (latencyMs > 0) {
      state.health = state.health === 'unknown' ? 'healthy' : state.health;
    }
  }

  public async runHealthCheck(id: string): Promise<HealthCheckSummary | null> {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state) return null;

    const checkedAt = new Date().toISOString();
    let status: ProviderHealthStatus = 'healthy';
    let latencyMs = 0;
    let errorMessage: string | undefined;

    try {
      latencyMs = await provider.measureLatency();
      if (provider.config.status === 'offline') {
        status = 'down';
        errorMessage = `${provider.config.name} is offline`;
      } else if (provider.config.status === 'maintenance') {
        status = 'degraded';
        errorMessage = `${provider.config.name} is under maintenance`;
      } else if (state.errorRate >= 50) {
        status = 'degraded';
        errorMessage = `Elevated error rate: ${state.errorRate}%`;
      }
    } catch (err: any) {
      status = 'down';
      errorMessage = err.message;
    }

    state.health = status;
    if (status === 'healthy' || status === 'degraded') {
      state.lastSuccessfulRequest = checkedAt;
    }

    return { providerId: id, status, latencyMs, checkedAt, errorMessage };
  }

  public async runHealthChecks(): Promise<HealthCheckSummary[]> {
    const results = await Promise.all(
      Array.from(this.providers.keys()).map(id => this.runHealthCheck(id))
    );
    return results.filter((s): s is HealthCheckSummary => s !== null);
  }
}
