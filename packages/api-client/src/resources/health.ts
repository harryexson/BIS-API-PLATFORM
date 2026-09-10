import { HttpClient } from '../http';
import { LivenessStatus, ReadinessStatus, RequestOptions } from '../types';

export class HealthResource {
  constructor(private readonly http: HttpClient) {}

  /** GET /health — liveness only ("is the process up"), unauthenticated. */
  async get(opts?: RequestOptions): Promise<LivenessStatus> {
    return this.http.request<LivenessStatus>('GET', '/health', {
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }

  /** GET /ready — readiness, including per-dependency status (database, rate limiter). */
  async ready(opts?: RequestOptions): Promise<ReadinessStatus> {
    return this.http.request<ReadinessStatus>('GET', '/ready', {
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }
}
