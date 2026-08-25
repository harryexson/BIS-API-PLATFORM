import { HttpClient } from './http';
import { ApiError } from './errors';
import { PaymentsResource } from './resources/payments';
import { RefundsResource } from './resources/refunds';
import { MessagesResource } from './resources/messages';
import { ConversationsResource } from './resources/conversations';
import { ProvidersResource } from './resources/providers';
import { WebhooksResource } from './resources/webhooks';
import { HealthResource } from './resources/health';
import { Environment } from './types';

const DEFAULT_BASE_URLS: Record<Environment, string> = {
  production: 'https://api.company.com/v1',
  sandbox: 'https://sandbox.api.company.com/v1'
};

export interface CompanyApiClientOptions {
  apiKey: string;
  environment?: Environment;
  // Explicit base URL overrides `environment`.
  baseUrl?: string;
  timeoutMs?: number;
  // Inject a custom fetch (e.g. for testing or non-Node runtimes).
  fetchImpl?: typeof fetch;
}

export class CompanyApiClient {
  public readonly payments: PaymentsResource;
  public readonly refunds: RefundsResource;
  public readonly messages: MessagesResource;
  public readonly conversations: ConversationsResource;
  public readonly providers: ProvidersResource;
  public readonly webhooks: WebhooksResource;
  public readonly health: HealthResource;

  private readonly http: HttpClient;

  constructor(options: CompanyApiClientOptions) {
    if (!options.apiKey) {
      throw new Error('CompanyApiClient requires an `apiKey`');
    }
    const baseUrl =
      options.baseUrl || DEFAULT_BASE_URLS[options.environment || 'production'];

    this.http = new HttpClient({
      baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl
    });

    this.payments = new PaymentsResource(this.http);
    this.refunds = new RefundsResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.conversations = new ConversationsResource(this.http);
    this.providers = new ProvidersResource(this.http);
    this.webhooks = new WebhooksResource();
    this.health = new HealthResource(this.http);
  }
}

export { ApiError } from './errors';
export * from './types';
