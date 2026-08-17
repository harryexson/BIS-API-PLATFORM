// Schema
export * from './schema';

// Connection
export { getDb, getRawSql, checkDatabaseHealth, type NeonHttpDatabase } from './connection';

// Transactions
export { runInTransaction, getTransactionDb, type TransactionClient } from './transactions';

// Repositories
export * from './repositories';

// Crypto
export {
  encryptSecret,
  decryptSecret,
  hashApiKey,
  generateApiKey,
  type EncryptedPayload,
} from './crypto';

// Application Registry
export {
  ApplicationRegistry,
  type ApplicationRecord,
  type ApiKeyRecord,
  type CreateApplicationInput,
  type CreateApplicationOutput,
  type AuthenticateResult,
  type RotateKeyResult,
  type ApplicationRepository,
  type ApiKeyRepository,
} from './registry';
