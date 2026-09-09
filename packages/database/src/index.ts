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
  hashToken,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  generateVerificationToken,
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

// Tenant Registry
export {
  TenantRegistry,
  type TenantRecord,
  type TenantLinkRecord,
  type CreateTenantInput,
  type ResolveTenantResult,
  type TenantRepository,
  type TenantApplicationLinkRepository,
  type TenantAccessContext,
} from './tenant-registry';

// Auth Registry (customer signup/login — see docstring in auth-registry.ts
// for how this differs from application API-key auth and admin auth)
export {
  AuthRegistry,
  AuthError,
  ValidationError,
  ConflictError,
  type UserRecord,
  type PublicUser,
  type UserSessionRecord,
  type UserVerificationTokenRecord,
  type RoleRecord,
  type SignupInput,
  type SignupResult,
  type LoginInput,
  type LoginResult,
  type UserRepositoryForAuth,
  type UserSessionRepositoryForAuth,
  type UserVerificationTokenRepositoryForAuth,
  type RoleRepositoryForAuth,
} from './auth-registry';
