import { HttpClient } from '../http';
import { Payment, PaymentCreate, RequestOptions } from '../types';

export class PaymentsResource {
  constructor(private readonly http: HttpClient) {}

  async create(input: PaymentCreate, opts?: RequestOptions): Promise<Payment> {
    return this.http.request<Payment>('POST', '/payments', {
      body: input,
      idempotencyKey: opts?.idempotencyKey ?? input.idempotency_key,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }

  async get(id: string, opts?: RequestOptions): Promise<Payment> {
    return this.http.request<Payment>('GET', `/payments/${encodeURIComponent(id)}`, {
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }
}
