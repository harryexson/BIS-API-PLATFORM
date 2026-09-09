export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
export type TransactionStatus = 'success' | 'failed';
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

export interface SubscriptionPlan {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  priceCents: number;
  currency: string;
  billingInterval: string;
  features?: Record<string, unknown> | null;
  isActive: boolean;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantSubscription {
  id: string;
  appId: string;
  tenantId: string;
  planId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicket {
  id: string;
  appId: string;
  tenantId: string;
  requesterEmail: string;
  subject: string;
  status: string;
  priority: string;
  externalProvider?: string | null;
  externalRef?: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
}

export interface SupportTicketMessage {
  id: string;
  ticketId: string;
  authorType: string;
  authorEmail?: string | null;
  body: string;
  createdAt: string;
}

export interface AccessCredential {
  id: string;
  appId: string;
  tenantId: string;
  token: string;
  credentialType: string;
  purpose: string;
  ownerType: string;
  ownerRef: string;
  label?: string | null;
  status: string;
  issuedAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface DashboardMetrics {
  totalRequests: number;
  successRate: number;
  averageLatency: number;
  totalCost: number;
  volumePerProvider: Record<string, number>;
  volumePerApp: Record<string, number>;
}
