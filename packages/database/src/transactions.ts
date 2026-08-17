import { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { getDb } from './connection';

export type TransactionClient = Parameters<
  Parameters<NeonHttpDatabase<typeof schema>['transaction']>[0]
>[0];

export async function runInTransaction<T>(
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction(fn);
}

export function getTransactionDb() {
  return getDb();
}
