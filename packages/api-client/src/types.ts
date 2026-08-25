// Public DTOs for the BIS API Platform /v1 surface.
// These mirror the OpenAPI contract (docs/openapi.yaml) and are intentionally
// decoupled from internal @company/schemas types.

export type Environment = 'production' | 'sandbox';

export type ProviderCategory = 'payment' | 'messaging' | 'other';
export type ProviderStatus = 'online' | 'offline' | 'maintenance';
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export type PaymentMethod = 'card' | 'mobile_money' | 'bank_transfer' | 'wallet';
export type PaymentStatus = 'pending' | 'success' | 'failed' | 'reconciling';
export type RefundStatus = 'pending' | 'success' | 'failed';
export type MessageChannel = 'sms' | 'whatsapp' | 'email';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undeliverable';

export type RefundReason =
  | 'customer_requested'
  | 'duplicate'
  | 'fraudulent'
  | 'partial_shipment'
  | 'other';

export interface Fee {
  percent?: number;
  flat?: number;
  total?: number;
}

export interface PaymentError {
  code?: string;
  message?: string;
}

export interface PaymentCreate {
  app_id: string;
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  phone_number?: string;
  customer?: {
    email?: string;
    phone?: string;
    reference?: string;
  };
  provider_override?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

export interface Payment {
  id: string;
  object: 'payment';
  status: PaymentStatus;
  amount: number;
  currency: string;
  payment_method: PaymentMethod;
  app_id: string;
  provider?: string;
  provider_transaction_id?: string;
  fee?: Fee;
  customer?: { email?: string; phone?: string };
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  error?: PaymentError;
  created_at: string;
  updated_at?: string;
  settled_at?: string;
}

export interface RefundCreate {
  payment_id: string;
  amount?: number;
  currency?: string;
  reason?: RefundReason;
  metadata?: Record<string, unknown>;
}

export interface Refund {
  id: string;
  object: 'refund';
  payment_id: string;
  status: RefundStatus;
  amount: number;
  currency: string;
  reason?: string;
  provider_refund_id?: string;
  created_at: string;
}

export interface MessageCreate {
  app_id: string;
  channel: MessageChannel;
  recipient: string;
  subject?: string;
  content: string;
  provider_override?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  object: 'message';
  status: MessageStatus;
  channel: MessageChannel;
  recipient: string;
  subject?: string;
  content?: string;
  app_id: string;
  provider?: string;
  provider_message_id?: string;
  conversation_id?: string;
  cost?: number;
  created_at: string;
  delivered_at?: string;
}

export interface Conversation {
  id: string;
  object: 'conversation';
  participant: string;
  app_id: string;
  message_count: number;
  messages: Message[];
  has_more: boolean;
  next_cursor?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface Provider {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  environment?: 'test' | 'live';
  countries?: string[];
  currencies?: string[];
  capabilities?: string[];
  weight?: number;
  health?: ProviderHealthStatus;
  last_successful_request?: string | null;
  error_rate?: number;
  latency_estimate_ms?: { min?: number; max?: number };
}

export interface ProviderList {
  object: 'list';
  data: Provider[];
  has_more: boolean;
  next_cursor?: string | null;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface Health {
  status: HealthStatus;
  version?: string;
  timestamp: string;
  dependencies?: {
    database?: HealthStatus;
    event_bus?: HealthStatus;
    providers?: HealthStatus;
  };
}

export type WebhookEventType =
  | 'payment.pending'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.pending'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'message.sent'
  | 'message.delivered'
  | 'message.failed'
  | 'message.undeliverable';

export interface WebhookEvent {
  id: string;
  object: 'event';
  type: WebhookEventType;
  created_at: string;
  livemode: boolean;
  correlation_id?: string;
  data: Record<string, any>;
}

// Per-request options honored across all resources.
export interface RequestOptions {
  idempotencyKey?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface ListProvidersOptions extends RequestOptions {
  category?: ProviderCategory;
  capability?: string;
  country?: string;
  limit?: number;
  cursor?: string;
}
