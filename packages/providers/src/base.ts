import { ProviderConfig, TransactionEvent, PaymentRequest, MessageRequest, OtherRequest } from '@company/schemas';

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

export abstract class BaseProvider {
  public config: ProviderConfig;
  private _secrets: Record<string, string> = {};

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  protected get secrets(): Record<string, string> {
    return this._secrets;
  }

  public setSecrets(secrets: Record<string, string>): void {
    this._secrets = secrets;
  }

  /**
   * Make an HTTP request to the provider's API with automatic retry and timeout.
   *
   * Retry strategy:
   * - Retries on 429 (rate limit), 500-599 (server errors), and network errors
   * - Exponential backoff: 500ms → 1s → 2s (capped at 10s)
   * - Respects Retry-After header from 429 responses
   */
  protected async http_request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const {
      method,
      url,
      headers = {},
      body,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
    } = opts;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const fetchOpts: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          signal: controller.signal,
        };

        if (body && method !== 'GET') {
          fetchOpts.body = JSON.stringify(body);
        }

        const res = await fetch(url, fetchOpts);
        clearTimeout(timeout);

        // Parse response
        const contentType = res.headers.get('content-type') || '';
        let responseBody: any;
        if (contentType.includes('application/json')) {
          responseBody = await res.json();
        } else {
          responseBody = await res.text();
        }

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Retry on rate limit or server errors
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = res.headers.get('retry-after');
          const retryMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000);

          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, retryMs));
            continue;
          }
        }

        return {
          status: res.status,
          headers: responseHeaders,
          body: responseBody,
        };
      } catch (err: any) {
        clearTimeout(timeout);
        lastError = err;

        // Don't retry on abort (timeout) for the last attempt
        if (attempt < maxAttempts) {
          const retryMs = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000);
          await new Promise((r) => setTimeout(r, retryMs));
        }
      }
    }

    throw lastError || new Error(`HTTP request failed after ${maxAttempts} attempts`);
  }

  /**
   * Signs a payload using the provider's webhook secret.
   * Used for webhook verification.
   */
  protected async signPayload(payload: string): Promise<string> {
    const { createHmac } = await import('crypto');
    const secret = this.secrets.webhook_secret || this.secrets.api_key || '';
    return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  }

  /**
   * Verifies a webhook signature against the expected signature.
   */
  protected async verifyWebhookSignature(
    rawBody: string,
    signature: string,
    secret?: string,
  ): Promise<boolean> {
    const { createHmac, timingSafeEqual } = await import('crypto');
    const webhookSecret = secret || this.secrets.webhook_secret || '';
    if (!webhookSecret) return false;

    const expected = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Simulates provider processing delay (for simulated mode)
  protected async simulateLatency(): Promise<number> {
    const min = this.config.latencyMin;
    const max = this.config.latencyMax;
    const latency = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise((resolve) => setTimeout(resolve, latency));
    return latency;
  }

  // Public wrapper used by health checks to measure current latency.
  public async measureLatency(): Promise<number> {
    return this.simulateLatency();
  }

  // Checks status, throwing error if not online
  protected verifyAvailability() {
    if (this.config.status === 'offline') {
      throw new Error(`Provider ${this.config.name} is currently OFFLINE`);
    }
    if (this.config.status === 'maintenance') {
      throw new Error(`Provider ${this.config.name} is undergoing MAINTENANCE`);
    }
  }

  abstract processRequest(
    appId: string,
    payload: PaymentRequest | MessageRequest | OtherRequest,
    decisionReason: string
  ): Promise<TransactionEvent>;
}
