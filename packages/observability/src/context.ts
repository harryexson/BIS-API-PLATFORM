import { AsyncLocalStorage } from 'node:async_hooks';

// Request-scoped observability context. These fields are attached to every
// structured log line and metric emission that occurs while handling a request.
export interface RequestContext {
  requestId?: string;
  correlationId?: string;
  applicationId?: string;
  tenantId?: string;
  supplierId?: string;
  providerId?: string;
  operation?: string;
}

export const contextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return contextStorage.run(ctx, fn);
}

export function getContext(): RequestContext {
  return contextStorage.getStore() || {};
}

// Mutates the currently active request context (e.g. once a provider is chosen).
export function setContextField(key: keyof RequestContext, value: string | undefined): void {
  const store = contextStorage.getStore();
  if (store) {
    store[key] = value;
  }
}
