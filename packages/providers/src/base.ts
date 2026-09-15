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
          // Pass pre-serialized string bodies through as-is (e.g. XML for
          // providers that don't speak JSON) — a caller-supplied
          // Content-Type header above already overrides the JSON default.
          fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
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

  /**
   * Encodes params as application/x-www-form-urlencoded, the body format
   * several payment gateways (Stripe, NMI) require instead of JSON — a
   * JSON body against those APIs is rejected outright, not merely
   * misparsed. One level of nested-object flattening via bracket notation
   * (e.g. { metadata: { appId: 'x' } } -> "metadata[appId]=x"), which is
   * as deep as this platform's provider payloads currently nest. Skips
   * undefined/null values rather than serializing them as the literal
   * strings "undefined"/"null".
   */
  protected toFormBody(params: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          if (nestedValue === undefined || nestedValue === null) continue;
          parts.push(`${encodeURIComponent(key)}[${encodeURIComponent(nestedKey)}]=${encodeURIComponent(String(nestedValue))}`);
        }
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }
    return parts.join('&');
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

  // Whether this adapter currently has the real credentials it needs to
  // make a live API call — i.e. the same condition each adapter's
  // processRequest() already checks before falling back to simulated
  // processing (see each adapter's own `if (!this.apiKey ...)` guard).
  // Default true: simulation-only adapters (no real HTTP integration,
  // e.g. SignalHouse/FutureSMS/Email/the example adapters) never need real
  // credentials, so there's nothing to be "unconfigured" about. Adapters
  // with a real HTTP integration override this with their own credential
  // check — see registry.ts's getManagementView() for where this surfaces.
  public isConfigured(): boolean {
    return true;
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
