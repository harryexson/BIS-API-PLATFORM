// Structured error thrown for any non-2xx response from the gateway.
// The real gateway's error envelope is a flat { error: string } — no nested
// code/message object, no request_id in the body (that comes from the
// X-Request-Id response header instead).

import { ApiErrorShape } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly correlationId?: string;

  constructor(shape: ApiErrorShape, status: number, requestId?: string, correlationId?: string) {
    super(shape.error || `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
    this.correlationId = correlationId;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}
