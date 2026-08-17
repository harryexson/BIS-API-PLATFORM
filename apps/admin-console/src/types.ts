export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
export type TransactionStatus = 'success' | 'failed';

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
