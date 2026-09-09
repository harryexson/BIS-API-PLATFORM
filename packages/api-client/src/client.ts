import { HttpClient } from './http';
import { ApiError } from './errors';
import { PaymentsResource } from './resources/payments';
import { MessagesResource } from './resources/messages';
import { ProvidersResource } from './resources/providers';
import { WebhooksResource } from './resources/webhooks';
import { HealthResource } from './resources/health';
import { Environment } from './types';

// No /v1 prefix here — unlike the payment/messaging/provider routes (which
// embed their own /v1/api/gateway/... path), /health and /ready are
// unversioned top-level routes on the same gateway.
const DEFAULT_BASE_URLS: Record<Environment, string> = {
  production: 'https://api.company.com',
  sandbox: 'https://sandbox.api.company.com',
};

export interface CompanyApiClientOptions {
  apiKey: string;
  // Required — the gateway's resolveTenantContext middleware rejects every
  // /v1/api/gateway/* request that doesn't carry x-tenant-id.
  tenantId: string;
  environment?: Environment;
  // Explicit base URL overrides `environment`.
  baseUrl?: string;
  timeoutMs?: number;
  // Inject a custom fetch (e.g. for testing or non-Node runtimes).
  fetchImpl?: typeof fetch;
}

export class CompanyApiClient {
  public readonly payments: PaymentsResource;
  public readonly messages: MessagesResource;
  public readonly providers: ProvidersResource;
  public readonly webhooks: WebhooksResource;
  public readonly health: HealthResource;

  private readonly http: HttpClient;

  constructor(options: CompanyApiClientOptions) {
    if (!options.apiKey) {
      throw new Error('CompanyApiClient requires an `apiKey`');
    }
    if (!options.tenantId) {
      throw new Error('CompanyApiClient requires a `tenantId` — the gateway rejects requests without one');
    }
    const baseUrl = options.baseUrl || DEFAULT_BASE_URLS[options.environment || 'production'];

    this.http = new HttpClient({
      baseUrl,
      apiKey: options.apiKey,
      tenantId: options.tenantId,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });

    this.payments = new PaymentsResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.providers = new ProvidersResource(this.http);
    this.webhooks = new WebhooksResource();
    this.health = new HealthResource(this.http);
  }
}

export { ApiError } from './errors';
export * from './types';
