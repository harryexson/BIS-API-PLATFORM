import { HttpClient } from '../http';
import { Health, RequestOptions } from '../types';

export class HealthResource {
  constructor(private readonly http: HttpClient) {}

  async get(opts?: RequestOptions): Promise<Health> {
    return this.http.request<Health>('GET', '/health', {
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }
}
