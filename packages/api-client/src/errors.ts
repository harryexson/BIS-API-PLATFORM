// Structured error thrown for any non-2xx response from the API.
// Mirrors the `Error` envelope in docs/openapi.yaml.

export interface ApiErrorShape {
  code?:
    | 'invalid_request'
    | 'authentication_failed'
    | 'permission_denied'
    | 'not_found'
    | 'invalid_operation'
    | 'idempotency_conflict'
    | 'rate_limited'
    | 'provider_error'
    | 'internal_error';
  message?: string;
  request_id?: string;
  correlation_id?: string;
  details?: Array<{ field?: string; issue?: string }>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: ApiErrorShape['code'];
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly details?: ApiErrorShape['details'];
  // Present on 409 idempotency_conflict.
  readonly resource?: unknown;

  constructor(
    status: number,
    shape: ApiErrorShape,
    resource?: unknown
  ) {
    super(shape.message || `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = shape.code;
    this.requestId = shape.request_id;
    this.correlationId = shape.correlation_id;
    this.details = shape.details;
    this.resource = resource;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
