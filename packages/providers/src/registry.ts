import {
  ProviderConfig,
  ProviderManagement,
  ProviderEnvironment,
  ProviderHealthStatus,
  ProviderSecretMeta,
  ProviderCapabilityMatch,
  ProviderCircuitState,
  RoutingRule,
  HealthCheckSummary,
} from '@company/schemas';
import { randomUUID } from 'crypto';
import { logger } from '@company/observability';
import { BaseProvider } from './base';

import { StripeProvider } from './adapters/payments/stripe';
import { NMIProvider } from './adapters/payments/nmi';
import { FlutterwaveProvider } from './adapters/payments/flutterwave';
import { PawaPayProvider } from './adapters/payments/pawapay';
import { PayChanguProvider } from './adapters/payments/paychangu';
import { AirwallexProvider } from './adapters/payments/airwallex';
import { AuthorizeNetProvider } from './adapters/payments/authorizenet';
import { AdyenProvider } from './adapters/payments/adyen';
import { BraintreeProvider } from './adapters/payments/braintree';
import { CheckoutComProvider } from './adapters/payments/checkout';
import { PayPalProvider } from './adapters/payments/paypal';
import { PaystackProvider } from './adapters/payments/paystack';
import { SquareProvider } from './adapters/payments/square';
import { ExamplePaymentProvider } from './adapters/payments/example';

import { SignalHouseProvider } from './adapters/messaging/signalhouse';
import { InfobipProvider } from './adapters/messaging/infobip';
import { TwilioProvider } from './adapters/messaging/twilio';
import { WhatsAppProvider } from './adapters/messaging/whatsapp';
import { VonageProvider } from './adapters/messaging/vonage';
import { AfricasTalkingProvider } from './adapters/messaging/africastalking';
import { SinchProvider } from './adapters/messaging/sinch';
import { VibesProvider } from './adapters/messaging/vibes';
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

// Plain, DB-shape-agnostic form of a secret used only at the
// export/hydrate boundary with whatever's calling this package (see
// exportSecretsForPersistence/hydrateSecrets below) — deliberately not the
// same type as ProviderSecretMeta, which also carries the masked/id/
// lastUpdated fields this package derives itself, not a persistence
// layer's job to supply.
export interface PersistableProviderSecret {
  field: string;
  label: string;
  value: string;
  // Phase 15: carried through persistence so every replica shows (and can
  // DELETE by) the same secret id. Optional — rows written before Phase 15
  // have neither; one is generated on load.
  id?: string;
  lastUpdated?: string;
}

// ----------------------------------------------------
// PERSISTED PROVIDER STATE (gap register E12, Phase 15)
// ----------------------------------------------------
// The admin-controlled provider configuration — what an operator sets
// through the dashboard and expects every gateway/worker replica to route
// by, and to survive a restart. Previously this lived ONLY in this
// process's `management` Map (lost on restart, divergent across replicas).
// Runtime telemetry (health, errorRate, lastSuccessfulRequest) and the
// circuit breaker are deliberately NOT part of it: they are per-process
// observations of live traffic, not configuration (see the circuit breaker
// note on isCircuitAvailable()).
export interface PersistableProviderManagement {
  status: ProviderConfig['status'];
  weight: number;
  latencyMin: number;
  latencyMax: number;
  transactionFeePercent?: number;
  transactionFeeFlat?: number;
  messageCost?: number;
  environment: ProviderEnvironment;
  countries: string[];
  currencies: string[];
  capabilities: string[];
  priority: number;
  routingRules: RoutingRule[];
}

/** One provider's persisted state, as read back from the store. */
export interface PersistedProviderState {
  slug: string;
  /** 0 = no configuration has ever been persisted for this provider. */
  managementVersion: number;
  /**
   * The stored document. Typed `unknown` on purpose: it is read back from
   * storage, so every field is type-checked before use (applyManagement).
   */
  management: unknown;
  /** 0 = no secrets have ever been persisted for this provider. */
  secretsVersion: number;
  /**
   * Decrypts and returns the persisted secrets. THROWS when they cannot be
   * decrypted (e.g. SECRET_ENCRYPTION_KEY changed) — never silently returns
   * nothing (gap register D13).
   */
  readSecrets(): PersistableProviderSecret[];
}

export type ProviderStateWriteResult = { saved: true; version: number } | { saved: false };

/**
 * Where the registry's persisted state lives (Postgres, via
 * @company/database's providerStateStore). An interface so this package
 * stays DB-free (see docs/providers/ADDING_A_PROVIDER.md).
 *
 * Both writes are compare-and-set: they succeed only if the stored version
 * still equals `expectedVersion`, and return the new version. A `saved:
 * false` means another writer (usually another replica) got there first.
 */
export interface ProviderStateStore {
  loadAll(): Promise<PersistedProviderState[]>;
  load(slug: string): Promise<PersistedProviderState | null>;
  saveManagement(input: {
    slug: string;
    name: string;
    category: string;
    management: PersistableProviderManagement;
    expectedVersion: number;
  }): Promise<ProviderStateWriteResult>;
  saveSecrets(input: {
    slug: string;
    name: string;
    category: string;
    secrets: PersistableProviderSecret[];
    expectedVersion: number;
  }): Promise<ProviderStateWriteResult>;
}

export interface ProviderStateSyncReport {
  /** Providers whose configuration was replaced by a newer persisted version. */
  managementApplied: string[];
  /** Providers whose secrets were replaced by a newer persisted version. */
  secretsApplied: string[];
  /**
   * Providers whose persisted secrets could not be decrypted. Each such
   * provider is withheld from routing (isProviderAvailable() → false) until
   * a later version decrypts — it must not silently fall back to env-var or
   * simulated credentials (gap register D13).
   */
  secretFailures: Array<{ slug: string; version: number; error: string }>;
}

/** A persisted write kept losing the compare-and-set race. Nothing was changed. */
export class ProviderStateConflictError extends Error {
  readonly code = 'provider_state_conflict';
  constructor(readonly providerId: string, readonly kind: 'management' | 'secrets') {
    super(`Concurrent ${kind} updates to provider '${providerId}' — the change was not applied; retry.`);
    this.name = 'ProviderStateConflictError';
  }
}

const PERSISTED_WRITE_ATTEMPTS = 5;

const SECRET_MASK_MAX_VISIBLE = 4;
const SECRET_MASK_WIDTH = 8;

function newSecretId(): string {
  return 'sec_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
  circuitState: ProviderCircuitState;
  consecutiveFailures: number;
  circuitOpenedAt: number | null;
  // When the single in-flight HALF_OPEN recovery probe was dispatched
  // (null = no probe in flight). See tryAcquireDispatch().
  halfOpenProbeAt: number | null;
  // Version of the persisted configuration / secrets this process holds
  // (0 = none loaded). See syncFromStore().
  managementVersion: number;
  secretsVersion: number;
  // Set while this provider's persisted secrets cannot be decrypted; the
  // provider is withheld from routing meanwhile (gap register D13).
  secretsLoadError: { version: number; error: string } | null;
}

// Circuit breaker tuning. Configurable per Phase 21 of the master plan:
// failure threshold, open duration, half-open attempts, recovery threshold.
// A single failed half-open probe re-opens the circuit (recovery threshold
// of 1); this keeps the breaker simple while still preventing a flapping
// provider from being hammered.
const CIRCUIT_FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD) || 5;
const CIRCUIT_COOLDOWN_MS = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS) || 30_000;
// A half-open probe whose outcome is never reported (the caller crashed or
// dropped it) must not wedge the circuit in HALF_OPEN forever: after this
// long the probe slot is considered abandoned and a new probe may go out.
const CIRCUIT_PROBE_TIMEOUT_MS = Number(process.env.CIRCUIT_BREAKER_PROBE_TIMEOUT_MS) || CIRCUIT_COOLDOWN_MS;

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, BaseProvider> = new Map();
  private management: Map<string, ManagementState> = new Map();
  // Serializes persisted writes per provider within this process (see
  // mutatePersisted()).
  private writeChains: Map<string, Promise<unknown>> = new Map();

  private constructor() {
    this.initializeProviders();
    this.warnUnconfiguredLiveProviders();
  }

  /**
   * A fresh, independent registry — what a second gateway/worker replica (or
   * a restarted process) holds before it loads persisted state. Production
   * code uses getInstance(); this exists so multi-replica convergence and
   * restart behaviour can be exercised in one test process.
   */
  public static createIsolatedInstance(): ProviderRegistry {
    return new ProviderRegistry();
  }

  // P0: There was previously zero registration-time validation of any
  // kind — a 'live'-environment provider with a missing/wrong credential
  // silently fell back to simulated processing on every real request, with
  // no signal anywhere except the admin console's Provider Management tab
  // (which an operator has to think to check). This doesn't block startup
  // (a genuinely broken provider shouldn't take the whole gateway down —
  // other providers still need to serve traffic), but it does put the gap
  // in the startup logs where an operator deploying a new provider will
  // actually see it.
  private warnUnconfiguredLiveProviders(): void {
    for (const [id, provider] of this.providers) {
      const state = this.management.get(id);
      if (state?.environment === 'live' && !provider.isConfigured()) {
        logger.warn(
          "live provider has no real credentials configured — every request will fall back to simulated processing " +
            'until an admin adds its secret(s) (POST /api/dashboard/providers/:id/secrets) or the matching env var(s) are set',
          {
            operation: 'provider-registry',
            providerId: id,
            errorCode: 'LIVE_PROVIDER_UNCONFIGURED',
            status: 'degraded',
          },
        );
      }
    }
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

    this.register(new AdyenProvider({
      id: 'adyen',
      name: 'Adyen',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 130,
      latencyMax: 190,
      transactionFeePercent: 1.9,
      transactionFeeFlat: 0.12
    }), { environment: 'live', countries: ['*'], currencies: ['USD', 'EUR', 'GBP'], capabilities: ['card'] });

    this.register(new BraintreeProvider({
      id: 'braintree',
      name: 'Braintree',
      category: 'payment',
      status: 'online',
      weight: 45,
      latencyMin: 150,
      latencyMax: 210,
      transactionFeePercent: 2.59,
      transactionFeeFlat: 0.49
    }), { environment: 'live', countries: ['*'], currencies: ['USD', 'EUR', 'GBP', 'AUD', 'CAD'], capabilities: ['card'] });

    this.register(new AuthorizeNetProvider({
      id: 'authorizenet',
      name: 'Authorize.Net',
      category: 'payment',
      status: 'online',
      weight: 40,
      latencyMin: 150,
      latencyMax: 210,
      transactionFeePercent: 2.9,
      transactionFeeFlat: 0.30
    }), { environment: 'live', countries: ['US', 'CA'], currencies: ['USD', 'CAD'], capabilities: ['card'] });

    this.register(new CheckoutComProvider({
      id: 'checkout',
      name: 'Checkout.com',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 140,
      latencyMax: 200,
      transactionFeePercent: 1.8,
      transactionFeeFlat: 0.10
    }), { environment: 'live', countries: ['*'], currencies: ['USD', 'EUR', 'GBP'], capabilities: ['card'] });

    this.register(new PayPalProvider({
      id: 'paypal',
      name: 'PayPal',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 160,
      latencyMax: 230,
      transactionFeePercent: 3.49,
      transactionFeeFlat: 0.49
    }), { environment: 'live', countries: ['*'], currencies: ['USD', 'EUR', 'GBP'], capabilities: ['wallet'] });

    this.register(new PaystackProvider({
      id: 'paystack',
      name: 'Paystack',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 170,
      latencyMax: 240,
      transactionFeePercent: 1.5,
      transactionFeeFlat: 0.0
    }), { environment: 'live', countries: ['NG', 'GH', 'ZA', 'KE'], currencies: ['NGN', 'GHS', 'ZAR', 'KES'], capabilities: ['card'] });

    this.register(new SquareProvider({
      id: 'square',
      name: 'Square',
      category: 'payment',
      status: 'online',
      weight: 50,
      latencyMin: 150,
      latencyMax: 210,
      transactionFeePercent: 2.6,
      transactionFeeFlat: 0.10
    }), { environment: 'live', countries: ['US', 'CA', 'GB', 'AU'], currencies: ['USD', 'CAD', 'GBP', 'AUD'], capabilities: ['card'] });

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

    this.register(new TwilioProvider({
      id: 'twilio',
      name: 'Twilio',
      category: 'messaging',
      status: 'online',
      weight: 55,
      latencyMin: 100,
      latencyMax: 160,
      messageCost: 0.0079
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['sms', 'whatsapp'] });

    this.register(new WhatsAppProvider({
      id: 'whatsapp',
      name: 'WhatsApp Business Platform',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 110,
      latencyMax: 170,
      messageCost: 0.005
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['whatsapp'] });

    this.register(new VonageProvider({
      id: 'vonage',
      name: 'Vonage',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 100,
      latencyMax: 160,
      messageCost: 0.0067
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['sms'] });

    this.register(new AfricasTalkingProvider({
      id: 'africastalking',
      name: "Africa's Talking",
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 150,
      latencyMax: 220,
      messageCost: 0.006
    }), {
      environment: 'live',
      countries: ['KE', 'UG', 'TZ', 'RW', 'MW', 'NG', 'ZM', 'CI', 'ET', 'GH', 'ZA'],
      currencies: ['KES', 'UGX', 'TZS', 'RWF', 'MWK', 'NGN', 'ZMW', 'GHS', 'ZAR'],
      capabilities: ['sms']
    });

    this.register(new SinchProvider({
      id: 'sinch',
      name: 'Sinch',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 100,
      latencyMax: 160,
      messageCost: 0.007
    }), { environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['sms'] });

    this.register(new VibesProvider({
      id: 'vibes',
      name: 'Vibes',
      category: 'messaging',
      status: 'online',
      weight: 50,
      latencyMin: 120,
      latencyMax: 200,
      messageCost: 0.007
    }), { environment: 'live', countries: ['US', 'CA'], currencies: ['USD', 'CAD'], capabilities: ['sms'] });

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
    // No secrets at registration time — real credentials come from the
    // adapter's own process.env fallback (documented in .env.example) until
    // an admin adds one via addSecret(), which syncs into the adapter's
    // real BaseProvider.setSecrets(). This used to seed a fake random
    // 'sk_...' secret here that nothing ever consumed — purely decorative,
    // and actively dangerous once addSecret()/setSecrets() were wired for
    // real: it would have shadowed every adapter's process.env fallback
    // with garbage the moment secrets syncing went live.
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
      circuitState: 'closed',
      consecutiveFailures: 0,
      circuitOpenedAt: null,
      halfOpenProbeAt: null,
      managementVersion: 0,
      secretsVersion: 0,
      secretsLoadError: null,
      secrets: [],
    });
  }

  // Rebuilds the { field: value } map the adapter's real HTTP calls read
  // (this.secrets.<field> — see BaseProvider.setSecrets()) from whatever
  // secrets are currently stored for this provider, and pushes it into the
  // live provider instance. Called after every add/delete so the adapter's
  // next request sees the change immediately — no restart required.
  private syncSecrets(id: string): void {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state) return;

    const record: Record<string, string> = {};
    for (const s of state.secrets) {
      record[s.meta.field] = s.value;
    }
    provider.setSecrets(record);
  }

  public getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  // A provider is eligible to serve traffic in production only if it is
  // configured as 'live'. Outside production, 'test' providers remain usable
  // for local/staging development.
  public isLiveEligible(id: string): boolean {
    if (process.env.NODE_ENV !== 'production') return true;
    return this.management.get(id)?.environment === 'live';
  }

  public getAllConfigs(): ProviderConfig[] {
    return Array.from(this.providers.values()).map(p => p.config);
  }

  // Circuit breaker: whether a provider is currently ELIGIBLE to be
  // selected for routed traffic. A pure read (gap register A14b — this used
  // to flip OPEN → HALF_OPEN as a side effect of merely being checked, e.g.
  // while filtering a candidate pool, even for a provider that was never
  // then selected):
  //  - CLOSED: yes.
  //  - OPEN: no, until the cooldown has elapsed — then yes, as a candidate
  //    for the single recovery probe.
  //  - HALF_OPEN: only if no probe is in flight (or the in-flight probe has
  //    been abandoned past CIRCUIT_PROBE_TIMEOUT_MS).
  // Eligibility is not permission: the dispatcher must still win
  // tryAcquireDispatch() immediately before calling the provider, which is
  // what admits EXACTLY ONE probe (A14a).
  //
  // Scope (A14c, still open): this state is per process. Each gateway/worker
  // replica trips and recovers its own breaker from the traffic it sees; it
  // is not part of the persisted provider state (syncFromStore()).
  public isCircuitAvailable(id: string): boolean {
    const state = this.management.get(id);
    if (!state) return false;
    const now = Date.now();

    if (state.circuitState === 'closed') return true;
    if (state.circuitState === 'open') {
      return now - (state.circuitOpenedAt ?? 0) >= CIRCUIT_COOLDOWN_MS;
    }
    return !this.probeInFlight(state, now);
  }

  private probeInFlight(state: ManagementState, now: number): boolean {
    return state.halfOpenProbeAt !== null && now - state.halfOpenProbeAt < CIRCUIT_PROBE_TIMEOUT_MS;
  }

  /**
   * Claims the right to send ONE request to this provider right now, called
   * by the dispatcher immediately before the provider call (gap register
   * A14a). CLOSED: always granted. OPEN past its cooldown: transitions to
   * HALF_OPEN and grants the single recovery probe. HALF_OPEN: granted only
   * when no probe is in flight. Every other caller is refused and must route
   * elsewhere — nothing was sent. The probe is resolved by recordTraffic()
   * (success → CLOSED, failure → OPEN) or handed back by releaseDispatch().
   */
  public tryAcquireDispatch(id: string): boolean {
    const state = this.management.get(id);
    if (!state) return false;
    const now = Date.now();

    if (state.circuitState === 'closed') return true;
    if (state.circuitState === 'open') {
      if (now - (state.circuitOpenedAt ?? 0) < CIRCUIT_COOLDOWN_MS) return false;
      state.circuitState = 'half_open';
      state.halfOpenProbeAt = now;
      return true;
    }
    if (this.probeInFlight(state, now)) return false;
    state.halfOpenProbeAt = now;
    return true;
  }

  /**
   * Hands back a dispatch claimed by tryAcquireDispatch() whose call ended
   * WITHOUT telling us anything about the provider's health (a definite
   * pre-send refusal: missing input, not configured, ...). A HALF_OPEN probe
   * slot is freed for the next request; nothing is recorded.
   */
  public releaseDispatch(id: string): void {
    const state = this.management.get(id);
    if (state && state.circuitState === 'half_open') state.halfOpenProbeAt = null;
  }

  // Combines the admin-controlled online/offline/maintenance status with
  // circuit breaker availability — this is the single check routing should
  // use to decide whether a provider is eligible for a request right now.
  // A provider whose persisted secrets failed to decrypt is withheld too:
  // routing it would silently use env-var (or simulated) credentials instead
  // of the ones an operator stored (gap register D13).
  public isProviderAvailable(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider || provider.config.status !== 'online') return false;
    if (this.management.get(id)?.secretsLoadError) return false;
    return this.isCircuitAvailable(id);
  }

  // Capability-based routing: find providers by category + required capabilities + supported currencies
  public findByCategoryAndCapabilities(
    category: 'payment' | 'messaging' | 'other',
    requiredCapabilities: string[],
    currency?: string,
    country?: string,
  ): ProviderCapabilityMatch[] {
    const matches: ProviderCapabilityMatch[] = [];

    for (const [id, provider] of this.providers) {
      const config = provider.config;
      if (config.category !== category) continue;
      if (!this.isProviderAvailable(id)) continue;

      const state = this.management.get(id);
      if (!state) continue;

      // Production traffic must never be routed to a 'test'-environment provider
      // (e.g. example/demo adapters that fabricate success without real processing).
      if (process.env.NODE_ENV === 'production' && state.environment !== 'live') continue;

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

      // Check country support if specified — real routing input as of
      // this pass: previously `countries` was collected and admin-
      // configurable but never actually consulted here, the same
      // "decorative field" gap routing rules and transaction fees had
      // before earlier passes wired those in too.
      if (country) {
        const c = country.toUpperCase();
        if (!state.countries.includes(c) && !state.countries.includes('*')) continue;
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
        errorRate: state.errorRate,
        transactionFeePercent: config.transactionFeePercent,
        transactionFeeFlat: config.transactionFeeFlat,
        messageCost: config.messageCost,
      });
    }

    // Sort by weight descending — callers that want success-rate/cost-aware
    // ordering re-sort by packages/routing's computeProviderScore() instead;
    // this default keeps every existing caller of this method unaffected.
    matches.sort((a, b) => b.weight - a.weight);
    return matches;
  }

  // Every enabled routing rule across every provider's management state —
  // RoutingRule.target is an explicit provider id, not necessarily the
  // provider the rule happens to be stored under (the admin console's "Add
  // Rule" lives on a provider's own page for convenience, but a rule means
  // "IF <match> route to <target>" regardless of storage location). Added
  // 2026-09-25: this data had full CRUD (add/update/delete) and an admin
  // console UI since an earlier pass, but nothing ever read it back —
  // RoutingEngine never called this method, so every rule an admin created
  // was purely decorative. See docs/IMPLEMENTATION_BASELINE.md.
  public getEnabledRoutingRules(): RoutingRule[] {
    const rules: RoutingRule[] = [];
    for (const state of this.management.values()) {
      for (const rule of state.routingRules) {
        if (rule.enabled) rules.push(rule);
      }
    }
    return rules;
  }

  public updateProviderConfig(id: string, updates: Partial<ProviderConfig>): ProviderConfig | null {
    const provider = this.providers.get(id);
    if (!provider) return null;

    provider.config = {
      ...provider.config,
      ...updates
    };

    // Manually bringing a provider back online resets the circuit — an
    // operator's explicit judgment overrides the automatic breaker.
    if (updates.status === 'online') {
      const state = this.management.get(id);
      if (state) {
        state.circuitState = 'closed';
        state.consecutiveFailures = 0;
        state.circuitOpenedAt = null;
        state.halfOpenProbeAt = null;
      }
    }

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
      routingRules: state.routingRules,
      circuitState: state.circuitState,
      consecutiveFailures: state.consecutiveFailures,
      configured: provider.isConfigured(),
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
      // Manually bringing a provider back online resets the circuit —
      // an operator's explicit judgment overrides the automatic breaker.
      if (updates.status === 'online') {
        state.circuitState = 'closed';
        state.consecutiveFailures = 0;
        state.circuitOpenedAt = null;
        state.halfOpenProbeAt = null;
      }
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

  // Gap register D13/E14: this used to show the first 6 AND last 4
  // characters — the ENTIRE value of any secret of 10 characters or fewer,
  // and 10 characters of every longer one ('sk_test_123' → 'sk_tes…_123').
  // Now: at most a quarter of the value, capped at 4 characters, from the
  // front only, followed by a fixed-width mask that also hides the length.
  // A secret of 3 characters or fewer shows nothing at all.
  public static maskSecret(value: string): string {
    const visible = Math.min(SECRET_MASK_MAX_VISIBLE, Math.floor(value.length / 4));
    return `${value.slice(0, visible)}${'•'.repeat(SECRET_MASK_WIDTH)}`;
  }

  private maskSecret(value: string): string {
    return ProviderRegistry.maskSecret(value);
  }

  public getSecrets(id: string): ProviderSecretMeta[] | null {
    const state = this.management.get(id);
    if (!state) return null;
    return state.secrets.map(s => s.meta);
  }

  public addSecret(
    id: string,
    input: { field: string; label: string; value: string }
  ): ProviderSecretMeta | null {
    const state = this.management.get(id);
    if (!state) return null;

    // Upsert by field: setting the same field again (e.g. rotating an API
    // key) replaces the previous entry rather than leaving a stale
    // duplicate that syncSecrets() would silently shadow anyway (a
    // Record<field,value> can only hold one value per field — the last one
    // written wins, so an unreplaced duplicate would be confusing dead
    // weight in the admin console's secrets list for no reason).
    const meta: ProviderSecretMeta = {
      id: 'sec_' + randomUUID().replace(/-/g, '').slice(0, 12),
      field: input.field,
      label: input.label,
      masked: this.maskSecret(input.value),
      lastUpdated: new Date().toISOString()
    };
    state.secrets = state.secrets.filter(s => s.meta.field !== input.field);
    state.secrets.push({ meta, value: input.value });
    this.syncSecrets(id);
    return meta;
  }

  public deleteSecret(id: string, secretId: string): boolean {
    const state = this.management.get(id);
    if (!state) return false;
    const before = state.secrets.length;
    state.secrets = state.secrets.filter(s => s.meta.id !== secretId);
    const removed = state.secrets.length < before;
    if (removed) this.syncSecrets(id);
    return removed;
  }

  // ----------------------------------------------------
  // SECRETS PERSISTENCE (caller-driven — this package stays DB-free)
  // ----------------------------------------------------
  // packages/providers has no dependency on @company/database (see
  // docs/providers/ADDING_A_PROVIDER.md) and ProviderRegistry's
  // constructor is synchronous, so it cannot load from a real DB itself.
  // Instead, services/api-gateway (which already depends on both
  // packages) calls exportSecretsForPersistence() after every
  // addSecret()/deleteSecret() to get what to encrypt and store, and
  // calls hydrateSecrets() once at startup with whatever it decrypts back
  // — this stays a plain in-memory operation either way, so
  // packages/simulation's tests need no special-casing to exercise it.

  // Exposes the current plaintext secrets for a provider so the caller can
  // encrypt and persist them. Not a new trust boundary: every value here
  // is exactly what the caller's own prior addSecret() call already
  // supplied in plaintext.
  public exportSecretsForPersistence(id: string): PersistableProviderSecret[] | null {
    const state = this.management.get(id);
    if (!state) return null;
    return state.secrets.map(s => ({ field: s.meta.field, label: s.meta.label, value: s.value }));
  }

  // Restores secrets loaded from persisted storage at startup. Never
  // clobbers secrets already present — a fresh addSecret() call earlier in
  // this same process (e.g. from a test, or a request that raced startup)
  // always wins over what was loaded from disk.
  public hydrateSecrets(id: string, secrets: PersistableProviderSecret[]): void {
    const state = this.management.get(id);
    if (!state || state.secrets.length > 0 || secrets.length === 0) return;
    state.secrets = secrets.map(s => ({
      meta: {
        id: 'sec_' + randomUUID().replace(/-/g, '').slice(0, 12),
        field: s.field,
        label: s.label,
        masked: this.maskSecret(s.value),
        lastUpdated: new Date().toISOString(),
      },
      value: s.value,
    }));
    this.syncSecrets(id);
  }

  // ----------------------------------------------------
  // PERSISTED STATE: LOAD / CONVERGE / WRITE (gap register E12, Phase 15)
  // ----------------------------------------------------
  // The store (Postgres) is the source of truth for provider configuration
  // and secrets. Every process:
  //  - loads it at startup, AWAITED before serving traffic (syncFromStore);
  //  - re-syncs periodically, applying any version newer than its own, so
  //    every gateway/worker replica converges on an admin change within one
  //    refresh interval (see ProviderStateSync in ./state-sync.ts);
  //  - writes through it (mutatePersisted): an admin change is reported as
  //    applied only once it is durably stored, and a lost compare-and-set
  //    race or a failed write leaves this process's state as it was.

  /** The admin-controlled configuration of one provider, as persisted. */
  public exportManagementForPersistence(id: string): PersistableProviderManagement | null {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state) return null;
    const c = provider.config;
    return {
      status: c.status,
      weight: c.weight,
      latencyMin: c.latencyMin,
      latencyMax: c.latencyMax,
      ...(c.transactionFeePercent !== undefined ? { transactionFeePercent: c.transactionFeePercent } : {}),
      ...(c.transactionFeeFlat !== undefined ? { transactionFeeFlat: c.transactionFeeFlat } : {}),
      ...(c.messageCost !== undefined ? { messageCost: c.messageCost } : {}),
      environment: state.environment,
      countries: [...state.countries],
      currencies: [...state.currencies],
      capabilities: [...state.capabilities],
      priority: state.priority,
      routingRules: state.routingRules.map((r) => ({ ...r })),
    };
  }

  /** The persisted versions this process currently holds (0 = none). */
  public getPersistedVersions(id: string): { management: number; secrets: number } | null {
    const state = this.management.get(id);
    return state ? { management: state.managementVersion, secrets: state.secretsVersion } : null;
  }

  /** Providers currently withheld from routing because their persisted secrets failed to decrypt. */
  public getSecretLoadFailures(): Array<{ slug: string; version: number; error: string }> {
    const out: Array<{ slug: string; version: number; error: string }> = [];
    for (const [slug, state] of this.management) {
      if (state.secretsLoadError) out.push({ slug, ...state.secretsLoadError });
    }
    return out;
  }

  // Applies a persisted configuration onto this process's state. Fields are
  // copied individually and type-checked — a malformed stored value keeps
  // the current one rather than poisoning routing. A transition to 'online'
  // resets the circuit (the same operator-override semantics as
  // updateManagement), unless this is a rollback of our own failed write.
  private applyManagement(id: string, doc: unknown, opts: { resetCircuitOnOnline: boolean }): void {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state || !doc || typeof doc !== 'object') return;
    const m = doc as Partial<PersistableProviderManagement>;
    const c = provider.config;
    const wasOnline = c.status === 'online';

    if (m.status === 'online' || m.status === 'offline' || m.status === 'maintenance') c.status = m.status;
    if (isFiniteNumber(m.weight)) c.weight = m.weight;
    if (isFiniteNumber(m.latencyMin)) c.latencyMin = m.latencyMin;
    if (isFiniteNumber(m.latencyMax)) c.latencyMax = m.latencyMax;
    if (isFiniteNumber(m.transactionFeePercent)) c.transactionFeePercent = m.transactionFeePercent;
    if (isFiniteNumber(m.transactionFeeFlat)) c.transactionFeeFlat = m.transactionFeeFlat;
    if (isFiniteNumber(m.messageCost)) c.messageCost = m.messageCost;
    if (m.environment === 'live' || m.environment === 'test') state.environment = m.environment;
    if (isStringArray(m.countries)) state.countries = [...m.countries];
    if (isStringArray(m.currencies)) state.currencies = [...m.currencies];
    if (isStringArray(m.capabilities)) state.capabilities = [...m.capabilities];
    if (isFiniteNumber(m.priority)) state.priority = m.priority;
    if (Array.isArray(m.routingRules)) {
      state.routingRules = m.routingRules
        .filter((r) => r && typeof r.id === 'string' && typeof r.match === 'string' && typeof r.target === 'string')
        .map((r) => ({ ...r, enabled: r.enabled !== false }));
    }

    if (opts.resetCircuitOnOnline && !wasOnline && c.status === 'online') {
      state.circuitState = 'closed';
      state.consecutiveFailures = 0;
      state.circuitOpenedAt = null;
      state.halfOpenProbeAt = null;
    }
  }

  // Authoritative replace of this provider's secrets (unlike hydrateSecrets,
  // which never clobbers): the persisted set IS the truth once loaded.
  private replaceSecrets(id: string, secrets: PersistableProviderSecret[]): void {
    const state = this.management.get(id);
    if (!state) return;
    state.secrets = secrets
      .filter((s) => s && typeof s.field === 'string' && typeof s.value === 'string')
      .map((s) => ({
        meta: {
          id: typeof s.id === 'string' && s.id ? s.id : newSecretId(),
          field: s.field,
          label: typeof s.label === 'string' ? s.label : s.field,
          masked: this.maskSecret(s.value),
          lastUpdated: typeof s.lastUpdated === 'string' ? s.lastUpdated : new Date().toISOString(),
        },
        value: s.value,
      }));
    this.syncSecrets(id);
  }

  // The full secrets set INCLUDING the metadata every replica must share
  // (id, lastUpdated) — what is encrypted and persisted.
  private exportSecretsWithMeta(id: string): PersistableProviderSecret[] {
    const state = this.management.get(id);
    if (!state) return [];
    return state.secrets.map((s) => ({
      field: s.meta.field,
      label: s.meta.label,
      value: s.value,
      id: s.meta.id,
      lastUpdated: s.meta.lastUpdated,
    }));
  }

  // Applies one persisted row's newer parts. Secrets that fail to decrypt
  // are NOT applied (and the provider is withheld from routing); the error
  // is reported, never swallowed.
  private applyPersistedRow(
    row: PersistedProviderState,
    kinds: { management: boolean; secrets: boolean },
    report: ProviderStateSyncReport,
  ): void {
    const state = this.management.get(row.slug);
    if (!state) return;

    if (kinds.management && row.management && typeof row.management === 'object' && row.managementVersion > state.managementVersion) {
      this.applyManagement(row.slug, row.management, { resetCircuitOnOnline: true });
      state.managementVersion = row.managementVersion;
      report.managementApplied.push(row.slug);
    }

    if (kinds.secrets && row.secretsVersion > state.secretsVersion) {
      try {
        const secrets = row.readSecrets();
        if (!Array.isArray(secrets)) throw new Error('persisted secrets are not a list');
        this.replaceSecrets(row.slug, secrets);
        state.secretsVersion = row.secretsVersion;
        state.secretsLoadError = null;
        report.secretsApplied.push(row.slug);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Reported once per failing version, but the provider stays
        // withheld (and listed by getSecretLoadFailures()) until it loads.
        if (state.secretsLoadError?.version !== row.secretsVersion) {
          report.secretFailures.push({ slug: row.slug, version: row.secretsVersion, error });
        }
        state.secretsLoadError = { version: row.secretsVersion, error };
      }
    }
  }

  /**
   * Loads every provider's persisted state and applies whatever is newer
   * than what this process holds. Called (awaited) at startup and then
   * periodically. Rejects only if the store itself fails; per-provider
   * decrypt failures are returned in the report.
   */
  public async syncFromStore(store: ProviderStateStore): Promise<ProviderStateSyncReport> {
    const report: ProviderStateSyncReport = { managementApplied: [], secretsApplied: [], secretFailures: [] };
    const rows = await store.loadAll();
    for (const row of rows) {
      this.applyPersistedRow(row, { management: true, secrets: true }, report);
    }
    return report;
  }

  /**
   * Applies an admin change THROUGH the store (gap register E12):
   *  1. re-read this provider's persisted state and converge on it;
   *  2. apply `mutate` locally (returning null = nothing to change / not
   *     found — nothing is written);
   *  3. compare-and-set the resulting full state against the version read in
   *     step 1. On success this process adopts the new version and the
   *     change is live. If another writer got there first, the local change
   *     is rolled back and the whole sequence retried on top of theirs; if
   *     the write fails (store unreachable, SECRET_ENCRYPTION_KEY missing,
   *     ...) the local change is rolled back and the error rethrown — so a
   *     caller never reports an unpersisted change as applied.
   * Writes to the same provider are serialized within this process.
   */
  public async mutatePersisted<T>(
    store: ProviderStateStore,
    id: string,
    kind: 'management' | 'secrets',
    mutate: () => T | null,
  ): Promise<T | null> {
    const previous = this.writeChains.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.mutatePersistedNow(store, id, kind, mutate));
    const chain = run.catch(() => undefined);
    this.writeChains.set(id, chain);
    try {
      return await run;
    } finally {
      if (this.writeChains.get(id) === chain) this.writeChains.delete(id);
    }
  }

  private async mutatePersistedNow<T>(
    store: ProviderStateStore,
    id: string,
    kind: 'management' | 'secrets',
    mutate: () => T | null,
  ): Promise<T | null> {
    const provider = this.providers.get(id);
    const state = this.management.get(id);
    if (!provider || !state) return null;

    for (let attempt = 1; attempt <= PERSISTED_WRITE_ATTEMPTS; attempt++) {
      const row = await store.load(id);
      if (row) {
        const report: ProviderStateSyncReport = { managementApplied: [], secretsApplied: [], secretFailures: [] };
        this.applyPersistedRow(row, { management: kind === 'management', secrets: kind === 'secrets' }, report);
        // Never overwrite persisted secrets this process cannot read: the
        // full-set write below would destroy them.
        if (kind === 'secrets' && state.secretsLoadError) {
          throw new Error(
            `Persisted secrets for provider '${id}' cannot be decrypted (${state.secretsLoadError.error}) — refusing to overwrite them.`,
          );
        }
      }

      const expectedVersion = kind === 'management' ? state.managementVersion : state.secretsVersion;
      const before = kind === 'management' ? this.exportManagementForPersistence(id)! : this.exportSecretsWithMeta(id);
      const rollback = () => {
        if (kind === 'management') {
          this.applyManagement(id, before as PersistableProviderManagement, { resetCircuitOnOnline: false });
          state.managementVersion = expectedVersion;
        } else {
          this.replaceSecrets(id, before as PersistableProviderSecret[]);
          state.secretsVersion = expectedVersion;
        }
      };

      const result = mutate();
      if (result === null) return null;

      let write: ProviderStateWriteResult;
      try {
        write = kind === 'management'
          ? await store.saveManagement({
              slug: id,
              name: provider.config.name,
              category: provider.config.category,
              management: this.exportManagementForPersistence(id)!,
              expectedVersion,
            })
          : await store.saveSecrets({
              slug: id,
              name: provider.config.name,
              category: provider.config.category,
              secrets: this.exportSecretsWithMeta(id),
              expectedVersion,
            });
      } catch (err) {
        rollback();
        throw err;
      }

      if (write.saved) {
        if (kind === 'management') state.managementVersion = write.version;
        else state.secretsVersion = write.version;
        return result;
      }
      // Lost the race: undo, then re-read their version and re-apply ours on top.
      rollback();
    }
    throw new ProviderStateConflictError(id, kind);
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
      state.consecutiveFailures = 0;
      // A successful half-open probe closes the circuit; a success while
      // closed is a no-op for circuit state.
      if (state.circuitState === 'half_open') {
        state.circuitState = 'closed';
        state.circuitOpenedAt = null;
        state.halfOpenProbeAt = null;
      }
    } else {
      state.errorRate = Math.min(100, Math.round((state.errorRate * 0.9 + 10) * 10) / 10);
      state.consecutiveFailures += 1;

      if (state.circuitState === 'half_open') {
        // Recovery probe failed — back to OPEN, restart the cooldown.
        state.circuitState = 'open';
        state.circuitOpenedAt = Date.now();
        state.halfOpenProbeAt = null;
      } else if (state.circuitState === 'closed' && state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        state.circuitState = 'open';
        state.circuitOpenedAt = Date.now();
      }
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
