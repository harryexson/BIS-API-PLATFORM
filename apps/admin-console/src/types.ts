export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
// 'unknown' = a payment provider timeout the routing engine deliberately
// left unresolved rather than risk a double charge — not a display bug.
export type TransactionStatus = 'success' | 'failed' | 'unknown';
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

export interface DashboardMetrics {
  totalRequests: number;
  successRate: number;
  averageLatency: number;
  totalCost: number;
  volumePerProvider: Record<string, number>;
  volumePerApp: Record<string, number>;
}
