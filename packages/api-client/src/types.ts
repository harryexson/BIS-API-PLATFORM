// Public DTOs for the BIS API Platform gateway. These intentionally mirror
// the *actual* services/api-gateway response shapes (camelCase, matching
// TransactionEvent) rather than a hypothetical REST-resource redesign —
// this package previously targeted a `/v1/payments`-style contract
// documented in docs/openapi.yaml that was never implemented server-side,
// which meant every call this client made 404'd or 400'd against the real
// gateway. Decoupled from @company/schemas on purpose: this is meant to be
// consumable outside the monorepo, so it defines its own copies of the
// fields it actually needs rather than importing internal workspace types.

export type Environment = 'production' | 'sandbox';

export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';
export type PaymentMethod = 'card' | 'mobile_money' | 'bank_transfer' | 'wallet';
export type TransactionStatus = 'success' | 'failed';

export interface PaymentCreate {
  amount: number;
  currency: string;
  paymentMethod: PaymentMethod;
  phoneNumber?: string;
  providerOverride?: string;
}

export interface MessageCreate {
  recipient: string;
  content: string;
  providerOverride?: string;
}

// Mirrors TransactionEvent from services/api-gateway — the shape every
// payment/messaging call actually returns, success or failure alike.
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
  payload: unknown;
  response: unknown;
  error?: string;
}

// GET /v1/api/gateway/transaction/:id
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

export interface ProviderCapabilityMatch {
  id: string;
  name: string;
  category: ProviderCategory;
  capabilities: string[];
  currencies: string[];
  countries: string[];
  weight: number;
  status: ProviderStatus;
}

export interface ProviderManagement {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  weight: number;
  environment: 'test' | 'live';
  countries: string[];
  currencies: string[];
  capabilities: string[];
  priority: number;
  health: ProviderHealthStatus;
  lastSuccessfulRequest: string | null;
  errorRate: number;
}

export interface ListProvidersOptions extends RequestOptions {
  category?: ProviderCategory;
  capability?: string;
  currency?: string;
}

// GET /v1/api/gateway/providers — a category+capability query returns the
// filtered ProviderCapabilityMatch shape; an unfiltered call returns the
// full ProviderManagement view for every registered provider. Real
// response, not the fictional {object:'list', data, has_more} envelope
// this client used to assume.
export interface ProviderListResponse {
  providers: ProviderCapabilityMatch[] | ProviderManagement[];
  count: number;
}

// GET /health (liveness) and GET /ready (readiness) — two distinct,
// unversioned endpoints, not one /v1/health resource.
export interface LivenessStatus {
  status: 'healthy';
  service: string;
  timestamp: string;
}

export interface ReadinessStatus {
  status: 'ready' | 'degraded';
  service: string;
  dependencies: Record<string, string>;
  timestamp: string;
}

// The real gateway's error envelope is a flat { error: string } — no
// nested code/message/request_id object. request_id/correlation_id are
// carried in the X-Request-Id/X-Correlation-Id response headers instead.
export interface ApiErrorShape {
  error: string;
}

// Per-request options honored across all resources.
export interface RequestOptions {
  idempotencyKey?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

// Outbound webhook deliveries (packages/events/src/webhook-delivery.ts)
// POST the raw TransactionEvent as the body — there is no wrapping envelope
// with a `type`/`created_at`/`data` shape, so this is just TransactionEvent
// again rather than a distinct WebhookEvent type.
export type WebhookEvent = TransactionEvent;
