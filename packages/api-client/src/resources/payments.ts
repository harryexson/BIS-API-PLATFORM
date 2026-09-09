import { HttpClient } from '../http';
import { PaymentCreate, RequestOptions, TransactionEvent, TransactionStatusResponse } from '../types';

export class PaymentsResource {
  constructor(private readonly http: HttpClient) {}

  /** POST /v1/api/gateway/payment */
  async create(input: PaymentCreate, opts?: RequestOptions): Promise<TransactionEvent> {
    return this.http.request<TransactionEvent>('POST', '/v1/api/gateway/payment', {
      body: input,
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }

  /**
   * GET /v1/api/gateway/transaction/:id — shared status-polling endpoint
   * for both payments and messages, scoped to the authenticated application.
   */
  async get(id: string, opts?: RequestOptions): Promise<TransactionStatusResponse> {
    return this.http.request<TransactionStatusResponse>('GET', `/v1/api/gateway/transaction/${encodeURIComponent(id)}`, {
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }
}
