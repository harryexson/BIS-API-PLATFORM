import { IdempotencyStore } from './types';

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen: Set<string>;

  constructor(private readonly capacity = 10000) {
    this.seen = new Set();
  }

  checkAndSet(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }
}
