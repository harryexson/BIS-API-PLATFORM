import { HttpClient } from '../http';
import { PaymentCreate, RefundCreate, RequestOptions, TransactionEvent, TransactionStatusResponse } from '../types';

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
   * POST /v1/api/gateway/refund — real support exists server-side for
   * Stripe, NMI, and Flutterwave (verified against each provider's own
   * API); any other provider resolves the returned TransactionEvent with
   * status 'failed' rather than fabricating a result. Does not accept an
   * idempotency key — the gateway route doesn't read one for this route.
   */
  async refund(input: RefundCreate, opts?: Omit<RequestOptions, 'idempotencyKey'>): Promise<TransactionEvent> {
    return this.http.request<TransactionEvent>('POST', '/v1/api/gateway/refund', {
      body: input,
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
