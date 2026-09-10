import { HttpClient } from '../http';
import { ListProvidersOptions, ProviderCapabilityMatch, ProviderListResponse, ProviderManagement, RequestOptions } from '../types';

export class ProvidersResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * GET /v1/api/gateway/providers. Passing `category` returns
   * capability-matched candidates (ProviderCapabilityMatch[]); omitting it
   * returns the full management view for every registered provider
   * (ProviderManagement[]) — the real gateway's two response shapes, not a
   * single uniform "list" envelope.
   */
  async list(opts?: ListProvidersOptions): Promise<ProviderListResponse> {
    return this.http.request<ProviderListResponse>('GET', '/v1/api/gateway/providers', {
      query: {
        category: opts?.category,
        capability: opts?.capability,
        currency: opts?.currency,
      },
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }

  /**
   * There is no server-side GET /v1/api/gateway/providers/:id — this is a
   * client-side convenience over list(), not a dedicated endpoint.
   */
  async get(id: string, opts?: RequestOptions): Promise<ProviderCapabilityMatch | ProviderManagement | undefined> {
    const { providers } = await this.list({ correlationId: opts?.correlationId, signal: opts?.signal });
    return providers.find((p) => p.id === id);
  }
}
