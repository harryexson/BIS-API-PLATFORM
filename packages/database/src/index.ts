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

// Supplier ownership chain (Phase 7, gap register F3.8): Application →
// Tenant → Supplier, verified hop by hop. DB-free; repositories injected.
export {
  SupplierScope,
  isUuid,
  type SupplierRecordForScope,
  type SupplierScopeApplicationRepo,
  type SupplierScopeLinkRepo,
  type SupplierScopeSupplierRepo,
  type SupplierScopeInput,
} from './supplier-scope';

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

// Subscription Registry (platform customer billing — see docstring in
// subscription-registry.ts)
export {
  SubscriptionRegistry,
  SubscriptionError,
  type PlanRecord,
  type SubscriptionRecord,
  type PlanRepositoryForBilling,
  type SubscriptionRepositoryForBilling,
  type ApplicationLookupForBilling,
} from './subscription-registry';

// Provider secrets persistence (survives a restart for packages/providers'
// in-memory ProviderRegistry — see docstring in provider-secrets.ts)
export {
  ensureProviderRow,
  persistProviderSecrets,
  loadAllProviderSecrets,
  currentDeploymentTier,
  type PersistableSecret,
} from './provider-secrets';

// CRM Registry (developer/support back office — see docstring in
// crm-registry.ts)
export {
  CrmRegistry,
  CrmError,
  type ApplicationSummary,
  type SubscriptionSummary,
  type PlanSummary,
  type UserSummary,
  type CustomerNoteRecord,
  type SupportTicketRecord,
  type TicketCommentRecord,
  type CustomerSummary,
  type CustomerDetail,
  type ApplicationRepositoryForCrm,
  type SubscriptionRepositoryForCrm,
  type PlanRepositoryForCrm,
  type UserRepositoryForCrm,
  type CustomerNoteRepositoryForCrm,
  type SupportTicketRepositoryForCrm,
  type TicketCommentRepositoryForCrm,
} from './crm-registry';

// Payment state machine (Phase 6 — gap register D4/D11): states, transition
// graph, and helpers. DB-free; see transaction-status.ts.
export {
  TRANSACTION_STATUSES,
  VALID_TRANSITIONS,
  REOPEN_FAILED_TRANSITION,
  UNRESOLVED_STATUSES,
  AMBIGUOUS_STATUSES,
  isValidTransactionStatus,
  isAllowedTransition,
  type PaymentTransactionStatus,
} from './transaction-status';

// Phase 8 (gap register A1-A4): canonical messaging-address form used by
// every conversation / messaging-profile / inbound-hold read and write.
export { normalizeMessagingAddress, channelFromAddress } from './messaging-address';
