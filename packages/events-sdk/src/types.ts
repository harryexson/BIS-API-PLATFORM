export type PlatformEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'message.delivered'
  | 'message.failed'
  | 'order.shipped'
  | 'order.delivered'
  | (string & {});

export interface PlatformEvent {
  id: string;
  object: 'event';
  type: PlatformEventType;
  created_at: string;
  livemode: boolean;
  correlation_id?: string;
  data: Record<string, any>;
}

export type EventHandler = (event: PlatformEvent) => void | Promise<void>;

export interface Unsubscribe {
  (): void;
}

export type ProcessStatus = 'dispatched' | 'duplicate' | 'invalid_signature' | 'ignored';

export interface ProcessResult {
  status: ProcessStatus;
  event?: PlatformEvent;
  matched: number;
  errors: Array<{ error: unknown }>;
}

export interface IdempotencyStore {
  checkAndSet(id: string): boolean | Promise<boolean>;
}

export interface EventSubscriberOptions {
  idempotencyStore?: IdempotencyStore;
  onError?: (event: PlatformEvent, error: unknown) => void;
}
