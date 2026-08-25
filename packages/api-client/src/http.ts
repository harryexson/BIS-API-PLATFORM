import { ApiError, ApiErrorShape } from './errors';

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
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

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl || ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  async request<T>(method: string, path: string, params: RequestParams = {}): Promise<T> {
    const url = buildUrl(this.baseUrl, path, params.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'company-api-client/1.0.0'
    };
    if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey;
    if (params.correlationId) headers['X-Correlation-Id'] = params.correlationId;

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
        signal
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const requestId = response.headers.get('X-Request-Id') || undefined;
    const correlationId = response.headers.get('X-Correlation-Id') || undefined;

    const text = await response.text();
    const data = (text ? safeJsonParse(text) : undefined) as Record<string, any> | undefined;

    if (!response.ok) {
      const shape = (data && (data.error as ApiErrorShape)) || {};
      const resource = data && data.resource;
      throw new ApiError(
        response.status,
        {
          code: shape.code,
          message: shape.message || response.statusText,
          request_id: requestId,
          correlation_id: correlationId,
          details: shape.details
        },
        resource
      );
    }

    return data as unknown as T;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
