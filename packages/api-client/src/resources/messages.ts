import { HttpClient } from '../http';
import { MessageCreate, RequestOptions, TransactionEvent, TransactionStatusResponse } from '../types';

export class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  /** POST /v1/api/gateway/messaging */
  async send(input: MessageCreate, opts?: RequestOptions): Promise<TransactionEvent> {
    return this.http.request<TransactionEvent>('POST', '/v1/api/gateway/messaging', {
      body: input,
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }

  /** GET /v1/api/gateway/transaction/:id — same shared endpoint payments.get() uses. */
  async get(id: string, opts?: RequestOptions): Promise<TransactionStatusResponse> {
    return this.http.request<TransactionStatusResponse>('GET', `/v1/api/gateway/transaction/${encodeURIComponent(id)}`, {
      correlationId: opts?.correlationId,
      signal: opts?.signal,
    });
  }
}
