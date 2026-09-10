import type { GatewaySession } from '../lib/secureStore';
import type { ApiError } from './types';

export class GatewayApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Shared low-level request helper for calling the gateway's
 * /v1/api/gateway/* routes (auth + tenant headers, flat error unwrapping).
 * No feature currently built on top of it — add a resource module here as
 * screens are added.
 */
export async function request<T>(session: GatewaySession, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${session.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.apiKey}`,
      'x-tenant-id': session.tenantId,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `Request failed (${res.status})` }))) as ApiError;
    throw new GatewayApiError(body.error || `Request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
