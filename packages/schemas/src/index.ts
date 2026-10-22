// Request-field validators shared by the gateway's routes (Phase 17-18, C10/F11).
export * from './request-validation';

export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
// 'unknown' is a legitimate, distinct outcome — not a synonym for 'failed'.
// A payment provider timeout means the request's outcome is genuinely
// unknown (it may have been charged); routing must never silently convert
// that into 'failed' (risks a false "declined" being retried into a real
// double charge) or 'success' (risks confirming a charge that never
// happened). See RoutingEngine.routePayment's timeout handling.
export type TransactionStatus = 'success' | 'failed' | 'unknown' | 'pending';

export type ProviderEnvironment = 'test' | 'live';
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

// Circuit breaker state for a provider, tracked independently of the
// admin-controlled `status` field. CLOSED = normal routing eligibility;
// OPEN = temporarily excluded from routing after repeated failures;
// HALF_OPEN = a single recovery probe is in flight.
export type ProviderCircuitState = 'closed' | 'open' | 'half_open';

export interface RoutingRule {
  id: string;
  match: string; // human readable match expression, e.g. "currency == MWK"
  target: string; // provider id to route to
  description?: string;
  enabled: boolean;
}

// Secret metadata only. The plaintext secret value is NEVER exposed to clients.
export interface ProviderSecretMeta {
  id: string;
  // The named field on BaseProvider.secrets this value populates (e.g.
  // 'api_key', 'client_id', 'username', 'password', 'gateway_id',
  // 'service_plan_id', 'base_url') — this is what actually makes a secret
  // entered through the admin console reach the adapter's real HTTP calls
  // (via ProviderRegistry syncing it into BaseProvider.setSecrets()), not
  // just display metadata. Each adapter's own `this.secrets.<field>` reads
  // document which field names it expects.
  field: string;
  label: string; // e.g. "Live API Key"
  masked: string; // masked representation, e.g. "sk_live_••••••••••1234"
  lastUpdated?: string; // ISO timestamp
}

export interface ProviderConfig {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  weight: number; // 0 to 100, used as routing priority
  latencyMin: number; // ms
  latencyMax: number; // ms
  transactionFeePercent?: number;
  transactionFeeFlat?: number;
  messageCost?: number;

  // ---- Provider management surface ----
  environment?: ProviderEnvironment;
  countries?: string[]; // supported countries (ISO codes) or ['*'] for global
  currencies?: string[]; // supported currencies (ISO codes)
  capabilities?: string[]; // supported capabilities (e.g. 'card', 'mobile_money', 'sms')
  priority?: number; // display alias for routing priority (defaults to weight)
  health?: ProviderHealthStatus;
  lastSuccessfulRequest?: string | null; // ISO timestamp of last successful request
  errorRate?: number; // rolling error rate percentage (0-100)
  routingRules?: RoutingRule[];
}

export interface TransactionEvent {
  id: string;
  timestamp: string;
  appId: string;
  // Phase 7 (gap register C4/C16): the tenant this event belongs to — the
  // tenant the originating request AUTHENTICATED as (x-tenant-id verified
  // against tenant_application_links by the gateway), or, for an event the
  // platform derives itself (a provider webhook, the outbox), the tenant of
  // the platform's own authoritative row (transactions.tenant_id /
  // conversations.tenant_id). Never taken from a request body or from a
  // provider payload's self-declared metadata. Outbound webhook dispatch is
  // scoped by (appId, tenantId): an event WITHOUT a tenantId is delivered to
  // no tenant's endpoint at all (fail closed) rather than to every tenant
  // of the application, which is what happened before this field existed.
  tenantId?: string;
  // Phase 7 (F3.8): the supplier this event was produced for, when the
  // request carried an x-supplier-id the gateway verified through the full
  // Application → Tenant → Supplier ownership chain. Absent otherwise.
  supplierId?: string;
  category: ProviderCategory;
  providerId: string;
  status: TransactionStatus;
  amount?: number;
  currency?: string;
  messageType?: string;
  latency: number;
  cost: number;
  decisionReason: string;
  payload: any;
  response: any;
  error?: string;
  // Third-party fraud-scoring signal, when the selected provider returns
  // one (currently only Stripe Radar — see stripe.ts's class comment).
  // Absent for a provider/response that carries no fraud signal at all —
  // never a fabricated neutral score standing in for "unknown".
  fraudRiskLevel?: string;
  fraudRiskScore?: number;
  // Payments only: the platform's own transactions.id this event belongs to
  // (see PaymentRequest.paymentTransactionId), when the caller allocated one.
  paymentTransactionId?: string;

  // ---- Messaging only: the channel decision (Phase 10, gap register A6/A9) ----
  // Stable, machine-checkable fields — the channel decision used to exist
  // only as free text inside decisionReason. Set by RoutingEngine.routeMessage
  // on EVERY messaging event it produces (success or failure).
  //
  // The channel the message was REQUESTED on: the caller's explicit
  // MessageRequest.channel, or — only when the caller sent none — the
  // legacy content-based default (see requestedChannelSource).
  requestedChannel?: MessageChannel;
  // 'explicit' = the caller named the channel; 'inferred' = the caller did
  // not, and the platform's backward-compatible default inference picked it.
  requestedChannelSource?: MessageChannelSource;
  // The channel the message was actually handed to a provider on. null on a
  // failure event (nothing was sent on any channel).
  selectedChannel?: MessageChannel | null;
  // null whenever selectedChannel === requestedChannel. When they differ it
  // is ALWAYS a specific, non-empty explanation (which providers of the
  // requested channel were unavailable/failed, and that the caller opted in
  // to a channel switch) — a channel is never changed silently.
  fallbackReason?: string | null;
}

/**
 * Phase 10 (gap register A6/A9): the communication channels outbound
 * messaging routes on. Each is also the provider capability name a
 * messaging adapter declares (ProviderConfig.capabilities).
 */
export type MessageChannel = 'sms' | 'whatsapp' | 'email';
export const MESSAGE_CHANNELS: readonly MessageChannel[] = ['sms', 'whatsapp', 'email'];
export type MessageChannelSource = 'explicit' | 'inferred';

/**
 * Phase 10: the per-request channel-switch policy. The platform default is
 * "never switch channel": an SMS whose SMS providers are all unavailable
 * FAILS rather than going out as an email/WhatsApp. A caller that genuinely
 * prefers a different channel to no message at all must opt in, per
 * message, here.
 */
export interface MessageChannelPolicy {
  // Default false. Only `true` (the boolean) enables a channel switch.
  allowChannelSwitch?: boolean;
  // Ordered channels to fall back to, tried only after every provider of
  // the requested channel is unavailable or has failed. Defaults (when
  // allowChannelSwitch is true and this is omitted) to every other channel
  // in MESSAGE_CHANNELS order.
  fallbackChannels?: MessageChannel[];
  // The recipient's address on a fallback channel whose address type
  // differs from the requested one (an email address for an SMS recipient).
  // sms <-> whatsapp reuse the original phone number when omitted; a
  // fallback channel with no usable address is skipped (and says so in the
  // failure/fallback reason) — a phone number is never "emailed".
  fallbackRecipients?: Partial<Record<MessageChannel, string>>;
}

// Request to BaseProvider.refund() — refunds a previously successful
// charge. `originalTransactionId` is the charging adapter's own id for
// that charge (whatever it returned as TransactionEvent.id when it
// succeeded — e.g. Stripe's PaymentIntent id); the caller resolves that
// from the platform's own `transactions` table, never from client input
// directly.
export interface RefundRequest {
  originalTransactionId: string;
  amount?: number;
  currency?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderManagement extends ProviderConfig {
  environment: ProviderEnvironment;
  countries: string[];
  currencies: string[];
  capabilities: string[];
  priority: number;
  health: ProviderHealthStatus;
  lastSuccessfulRequest: string | null;
  errorRate: number;
  routingRules: RoutingRule[];
  circuitState: ProviderCircuitState;
  consecutiveFailures: number;
  // Whether this adapter currently has real credentials to make a live API
  // call with (BaseProvider.isConfigured()) — distinct from `health`, which
  // is a rolling reflection of past traffic outcomes and stays "unknown"
  // forever for a provider that has never been called. A 'live'-environment
  // provider with configured: false will silently fall back to simulated
  // processing on every real request until this is fixed.
  configured: boolean;
}

export interface HealthCheckSummary {
  providerId: string;
  status: ProviderHealthStatus;
  latencyMs: number;
  checkedAt: string;
  errorMessage?: string;
}

export interface DashboardMetrics {
  totalRequests: number;
  successRate: number;
  averageLatency: number;
  totalCost: number;
  volumePerProvider: Record<string, number>;
  volumePerApp: Record<string, number>;
}

// ----------------------------------------------------
// TYPED PROVIDER CONTRACTS
// ----------------------------------------------------

export interface PaymentRequest {
  amount: number;
  currency: string;
  paymentMethod: string;
  phoneNumber?: string;
  // ISO 3166-1 alpha-2 country code (e.g. 'US', 'KE') the transaction is
  // associated with — the caller's or cardholder's country, not the
  // merchant's. Optional: when present, routing filters candidates to
  // providers whose configured `countries` list includes it (or '*');
  // when absent, routing is unchanged from before this field existed.
  country?: string;
  metadata?: Record<string, unknown>;
  // A pre-tokenized payment instrument reference the selected provider's
  // own API understands (e.g. a Stripe PaymentMethod id created client-side
  // via Stripe.js/Elements — this gateway never touches raw card data, so
  // it cannot create that token itself). Optional and provider-specific:
  // a real-HTTP adapter that needs one to actually move money (Stripe,
  // NMI) falls back to simulated processing when it's absent, rather than
  // fabricating a charge with no instrument to charge — outside production
  // only; in production that fallback throws instead (see BaseProvider's
  // refuseSimulatedFallbackInProduction).
  paymentToken?: string;
  // The client's own Idempotency-Key for this payment, exactly as received
  // by the gateway (header `Idempotency-Key`, or body `idempotency_key`).
  // Absent when the client sent none.
  idempotencyKey?: string;
  // The platform's own `transactions.id` for this payment — allocated by
  // the gateway (row created in status 'processing') BEFORE any provider is
  // called, so it is stable across adapter-internal HTTP retries, router
  // failover between providers, and a client retry of a definitively failed
  // attempt under the same Idempotency-Key. Every payment adapter derives
  // its provider-facing idempotency identity from this plus
  // `idempotencyKey` via BaseProvider's buildIdempotencyIdentity()
  // (`bis_<paymentTransactionId>_<idempotency identity>`), never from
  // Date.now()/random values. A real (non-simulated) provider call refuses
  // to proceed without it.
  paymentTransactionId?: string;
}

/**
 * What RoutingEngine.routePayment accepts: a PaymentRequest whose
 * currency/paymentMethod may be omitted (routing applies its documented
 * defaults, 'USD'/'card'), plus an optional explicit provider override.
 */
export interface PaymentRoutingRequest extends Omit<PaymentRequest, 'currency' | 'paymentMethod'> {
  currency?: string;
  paymentMethod?: string;
  providerOverride?: string;
}

export interface PaymentResponse {
  providerTransactionId: string;
  status: string;
  amount: number;
  currency: string;
  [key: string]: unknown;
}

export interface MessageRequest {
  recipient: string;
  content: string;
  subject?: string;
  // Phase 10 (gap register A6): the channel the caller wants this message
  // sent on. When present it is authoritative — it always wins over the
  // legacy content-based inference (recipient '@' -> email, body 'wa:' or
  // > 300 chars -> whatsapp, otherwise sms), which now only applies as a
  // backward-compatible default for callers that send no channel at all.
  // RoutingEngine also sets it on the payload it hands a provider adapter,
  // to the channel actually selected (adapters such as Twilio read it to
  // choose SMS vs WhatsApp).
  channel?: MessageChannel;
  // Phase 10 (gap register A9): opt-in channel-switch policy for this one
  // message. Absent = never switch channel.
  channelPolicy?: MessageChannelPolicy;
  [key: string]: unknown;
}

export interface MessageResponse {
  providerMessageId: string;
  status: string;
  channel: string;
  [key: string]: unknown;
}

export interface OtherRequest {
  serviceType: string;
  action?: string;
  [key: string]: unknown;
}

export interface OtherResponse {
  [key: string]: unknown;
}

// Capability-based routing query
export interface ProviderCapabilityMatch {
  id: string;
  name: string;
  category: ProviderCategory;
  capabilities: string[];
  currencies: string[];
  countries: string[];
  weight: number;
  status: ProviderStatus;
  // Live rolling error rate (0-100, see ProviderRegistry.recordTraffic) and
  // configured cost fields — carried through so RoutingEngine's scoring
  // (packages/routing/src/scoring.ts) can weigh a candidate by real success
  // rate and cost, not just its static admin-set weight.
  errorRate: number;
  transactionFeePercent?: number;
  transactionFeeFlat?: number;
  messageCost?: number;
}

// Transaction status tracking
export interface TransactionStatusResponse {
  id: string;
  status: TransactionStatus;
  providerId: string;
  category: ProviderCategory;
  amount?: number;
  currency?: string;
  messageType?: string;
  cost: number;
  latency: number;
  timestamp: string;
  providerTransactionId?: string;
  error?: string;
}

// ----------------------------------------------------
// PROVIDER WEBHOOK EVENT CONTRACT
// ----------------------------------------------------
// The complete event payload that must flow through the webhook → receipt pipeline.
// Every provider adapter must normalize its webhook into this shape.

export interface ProviderWebhookEvent {
  // Identification
  providerEventId: string;        // Unique event ID from the provider
  provider: string;               // Provider identifier (stripe, signalhouse, etc.)
  eventType: string;              // e.g. charge.succeeded, charge.refunded, sms.delivered

  // Ownership chain
  applicationId: string;          // Owning application slug
  tenantId?: string;              // Owning tenant ID
  supplierId?: string;            // Owning supplier/hotel/church ID
  organizationId?: string;        // Owning organization ID
  resourceId?: string;            // Specific resource (donation, message, etc.)

  // Correlation
  correlationId?: string;         // Client-provided correlation ID
  idempotencyKey?: string;        // Client-provided idempotency key

  // Event data
  status: TransactionStatus;      // Normalized status
  amount?: number;                // Amount in minor units
  currency?: string;              // ISO currency code
  payload: unknown;               // Raw provider event payload
  timestamp: string;              // ISO timestamp

  // Webhook verification
  rawBody?: string;               // Raw webhook body for HMAC verification
  signature?: string;             // Generic platform HMAC signature (x-webhook-signature); absent when verificationMethod is 'native'
  verificationMethod?: 'native' | 'platform'; // How the gateway verified this webhook before enqueueing it — see BaseProvider.verifyProviderWebhookSignature
}
