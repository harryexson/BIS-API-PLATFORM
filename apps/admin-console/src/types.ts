export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
// Mirrors @company/schemas' TransactionStatus — the full persisted transaction
// lifecycle. 'unknown' = a payment provider timeout the routing engine
// deliberately left unresolved rather than risk a double charge — not a
// display bug, and distinct from 'pending' (which implies a normal
// not-yet-attempted state).
export type TransactionStatus =
  | 'pending'
  | 'processing'
  | 'success'
  | 'failed'
  | 'refunded'
  | 'cancelled'
  | 'unknown';
export type ProviderEnvironment = 'test' | 'live';
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface RoutingRule {
  id: string;
  match: string;
  target: string;
  description?: string;
  enabled: boolean;
}

export interface ProviderSecretMeta {
  id: string;
  // The named field on the adapter's secrets this value populates (e.g.
  // 'api_key', 'client_id', 'username'). Required — this is what makes a
  // secret actually reach the adapter's real HTTP calls.
  field: string;
  label: string;
  masked: string;
  lastUpdated?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  weight: number;
  latencyMin: number;
  latencyMax: number;
  transactionFeePercent?: number;
  transactionFeeFlat?: number;
  messageCost?: number;
  environment?: ProviderEnvironment;
  countries?: string[];
  currencies?: string[];
  capabilities?: string[];
  priority?: number;
  health?: ProviderHealthStatus;
  lastSuccessfulRequest?: string | null;
  errorRate?: number;
  routingRules?: RoutingRule[];
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
  // Whether the adapter currently has real credentials configured — distinct
  // from `health`, which reflects past traffic and stays "unknown" until
  // the provider has actually been called.
  configured: boolean;
}

export interface HealthCheckSummary {
  providerId: string;
  status: ProviderHealthStatus;
  latencyMs: number;
  checkedAt: string;
  errorMessage?: string;
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

export interface Role {
  id: string;
  applicationId: string;
  name: string;
  description?: string | null;
  isSystem: string;
  createdAt: string;
  updatedAt: string;
}

export interface Permission {
  id: string;
  roleId: string;
  resource: string;
  action: string;
  createdAt: string;
}

// Mirrors packages/database/src/schema/plans.ts. 'billingInterval' is this
// API's field name for the DB's 'interval' column — kept distinct for
// clarity at this layer.
export interface SubscriptionPlan {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  priceCents: number;
  currency: string;
  billingInterval: string;
  messageLimit?: number | null;
  paymentVolumeLimitCents?: number | null;
  isActive: boolean;
  stripePriceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors packages/database/src/schema/subscriptions.ts — one subscription
// per application (not per tenant).
export interface ApplicationSubscription {
  id: string;
  applicationId: string;
  planId: string;
  status: string;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardMetrics {
  totalRequests: number;
  successRate: number;
  averageLatency: number;
  totalCost: number;
  volumePerProvider: Record<string, number>;
  volumePerApp: Record<string, number>;
}
