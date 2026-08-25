import { HttpClient } from '../http';
import { Conversation, RequestOptions } from '../types';

export class ConversationsResource {
  constructor(private readonly http: HttpClient) {}

  async get(id: string, opts?: RequestOptions): Promise<Conversation> {
    return this.http.request<Conversation>('GET', `/conversations/${encodeURIComponent(id)}`, {
      idempotencyKey: opts?.idempotencyKey,
      correlationId: opts?.correlationId,
      signal: opts?.signal
    });
  }
}
