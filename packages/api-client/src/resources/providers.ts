import { HttpClient } from '../http';
import { ListProvidersOptions, Provider, ProviderList } from '../types';

export class ProvidersResource {
  constructor(private readonly http: HttpClient) {}

  async list(opts?: ListProvidersOptions): Promise<ProviderList> {
    return this.http.request<ProviderList>('GET', '/providers', {
      query: {
        category: opts?.category,
        capability: opts?.capability,
        country: opts?.country,
        limit: opts?.limit,
        cursor: opts?.cursor
      },
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }

  async get(id: string, opts?: ListProvidersOptions): Promise<Provider> {
    return this.http.request<Provider>('GET', `/providers/${encodeURIComponent(id)}`, {
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }
}
