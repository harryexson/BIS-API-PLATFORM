export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
// 'unknown' is a legitimate, distinct outcome — not a synonym for 'failed'.
// A payment provider timeout means the request's outcome is genuinely
// unknown (it may have been charged); routing must never silently convert
// that into 'failed' (risks a false "declined" being retried into a real
// double charge) or 'success' (risks confirming a charge that never
// happened). See RoutingEngine.routePayment's timeout handling.
export type TransactionStatus = 'success' | 'failed' | 'unknown';

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
}

// Result of BaseProvider.processRefund() — a real refund attempt against a
// previously successful payment, distinct from TransactionEvent (which
// describes the original charge). 'unknown' mirrors TransactionStatus's own
// meaning here: a refund provider accepted asynchronously (e.g. Stripe's
// 'pending'/'requires_action') is genuinely unresolved, not a confirmed
// success or failure.
export interface RefundResult {
  status: TransactionStatus;
  refundId?: string;
  amount: number;
  currency: string;
  response?: any;
  error?: string;
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
  metadata?: Record<string, unknown>;
  // A pre-tokenized payment instrument reference the selected provider's
  // own API understands (e.g. a Stripe PaymentMethod id created client-side
  // via Stripe.js/Elements — this gateway never touches raw card data, so
  // it cannot create that token itself). Optional and provider-specific:
  // a real-HTTP adapter that needs one to actually move money (Stripe,
  // NMI) falls back to simulated processing when it's absent, rather than
  // fabricating a charge with no instrument to charge.
  paymentToken?: string;
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
