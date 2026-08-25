import { KVStore } from './store';
import { Keys } from './keys';

export interface IdempotencyRecord {
  status: 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  updatedAt: number;
}

export class IdempotencyStore {
  constructor(
    private store: KVStore,
    private keys: Keys,
    private ttlMs: number,
  ) {}

  async claim(key: string): Promise<'new' | 'processing' | 'completed' | 'failed'> {
    const existing = await this.store.get(this.keys.idempotency(key));
    if (existing) {
      const rec = JSON.parse(existing) as IdempotencyRecord;
      return rec.status;
    }
    const rec: IdempotencyRecord = {
      status: 'processing',
      updatedAt: Date.now(),
    };
    await this.store.set(this.keys.idempotency(key), JSON.stringify(rec), this.ttlMs);
    return 'new';
  }

  async complete(key: string, result: any): Promise<void> {
    const rec: IdempotencyRecord = {
      status: 'completed',
      result,
      updatedAt: Date.now(),
    };
    await this.store.set(this.keys.idempotency(key), JSON.stringify(rec), this.ttlMs);
  }

  async fail(key: string, error: string): Promise<void> {
    const rec: IdempotencyRecord = {
      status: 'failed',
      error,
      updatedAt: Date.now(),
    };
    await this.store.set(this.keys.idempotency(key), JSON.stringify(rec), this.ttlMs);
  }

  async release(key: string): Promise<void> {
    await this.store.del(this.keys.idempotency(key));
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.store.get(this.keys.idempotency(key));
    return raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
  }
}
