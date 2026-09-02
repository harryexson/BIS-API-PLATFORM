import { HttpClient } from '../http';
import { Refund, RefundCreate, RequestOptions } from '../types';

export class RefundsResource {
  constructor(private readonly http: HttpClient) {}

  async create(input: RefundCreate, opts?: RequestOptions): Promise<Refund> {
    return this.http.request<Refund>('POST', '/refunds', {
      body: input,
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }
}
