import { ApiError } from './errors';
import { ApiErrorShape } from './types';

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  // Required for every /v1/api/gateway/* call — the gateway's
  // resolveTenantContext middleware rejects requests without it.
  tenantId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestParams {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

function buildUrl(baseUrl: string, path: string, query?: RequestParams['query']): string {
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly tenantId: string;
  private readonly timeoutMs?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.tenantId = options.tenantId;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl || ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  async request<T>(method: string, path: string, params: RequestParams = {}): Promise<T> {
    const url = buildUrl(this.baseUrl, path, params.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'company-api-client/1.0.0',
      'x-tenant-id': this.tenantId,
    };
    // Matches services/api-gateway's actual header name (req.header('x-idempotency-key')) —
    // not the Stripe-style `Idempotency-Key` this client previously sent, which the
    // gateway never reads.
    if (params.idempotencyKey) headers['x-idempotency-key'] = params.idempotencyKey;
    if (params.correlationId) headers['x-correlation-id'] = params.correlationId;

    const controller = this.timeoutMs ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller) {
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    }
    const signal = controller ? controller.signal : params.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
        signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const requestId = response.headers.get('X-Request-Id') || undefined;
    const correlationId = response.headers.get('X-Correlation-Id') || undefined;

    const text = await response.text();
    const data = text ? safeJsonParse(text) : undefined;

    if (!response.ok) {
      // The gateway's error body is a flat { error: string }. Fall back to
      // statusText only if the body genuinely didn't parse as that shape —
      // previously this always fell back to statusText because it expected
      // data.error to be an object with a .message field, which it never is.
      const shape: ApiErrorShape =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).error === 'string'
          ? (data as ApiErrorShape)
          : { error: response.statusText };
      throw new ApiError(shape, response.status, requestId, correlationId);
    }

    return data as T;
  }
}
