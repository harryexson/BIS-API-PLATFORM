export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
export type TransactionStatus = 'success' | 'failed';

export type ProviderEnvironment = 'test' | 'live';
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

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
