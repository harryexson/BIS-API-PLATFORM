import { HttpClient } from '../http';
import { Message, MessageCreate, RequestOptions } from '../types';

export class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  async send(input: MessageCreate, opts?: RequestOptions): Promise<Message> {
    return this.http.request<Message>('POST', '/messages', {
      body: input,
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }

  async get(id: string, opts?: RequestOptions): Promise<Message> {
    return this.http.request<Message>('GET', `/messages/${encodeURIComponent(id)}`, {
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }
}
