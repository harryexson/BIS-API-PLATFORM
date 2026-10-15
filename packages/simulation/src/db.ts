import { createHash, randomUUID } from 'node:crypto';
// Relative import (not the '@company/database' package specifier) — this
// file's whole point is to stand in for that package under vi.mock, so it
// can't import from it. crypto.ts has no DB dependency of its own (pure
// node:crypto), so reusing the real implementation here is safe and keeps
// password/session/token handling identical to production.
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateSessionToken,
  generateVerificationToken,
  generateApiKey,
  encryptSecret,
  decryptSecret,
  type EncryptedPayload,
} from '../../database/src/crypto';
// DB-free payment status machine, shared verbatim with the real repository
// (same relative-import reasoning as crypto.ts above).
import {
  transactionStatusesAllowedInto,
  paymentOutcomeFromEvent,
  VALID_STATUSES as TX_VALID_STATUSES,
  AMBIGUOUS_STATUSES as TX_AMBIGUOUS_STATUSES,
  UNRESOLVED_STATUSES as TX_UNRESOLVED_STATUSES,
} from '../../database/src/transaction-status';
// DB-free outbox consumer policy, shared verbatim with the real repository —
// outboxPoller.ts does real arithmetic with these (e.g. staleAfterMs defaults).
import { DEFAULT_OUTBOX_RETRY_POLICY, DEFAULT_OUTBOX_STALE_AFTER_MS } from '../../database/src/outbox-policy';
// DB-free supplier ownership chain (Phase 7, F3.8), shared verbatim with the
// real package — the mock injects its own in-memory repositories into it.
import { SupplierScope, isUuid } from '../../database/src/supplier-scope';
import { normalizeMessagingAddress, channelFromAddress } from '../../database/src/messaging-address';

const MESSAGING_PROFILE_COMPLIANCE_STATUSES = new Set(['unregistered', 'pending', 'approved', 'rejected', 'suspended']);
const MESSAGING_PROFILE_SENDER_TYPES = new Set(['phone', '10dlc', 'tollfree', 'shortcode', 'alphanumeric']);

// ---------------------------------------------------------------------------
// In-memory "Neon" database double used by the simulation.
// The killer feature: the same state object is used by the mock module factory
// AND by the test assertions, and every repository honours two fault-injection
// toggles (failEventWrites / failAuditWrites) so we can deliberately take the
// database down mid-flow and observe how the real application reacts.
// ---------------------------------------------------------------------------

export interface EventRow {
  id: string;
  appId: string;
  category: string;
  providerId: string | null;
  status: string | null;
  amount: string | null;
  currency: string | null;
  latency: number | null;
  cost: string | null;
  decisionReason: string | null;
  payload: unknown;
  response: unknown;
  error: string | null;
  /** events.idempotency_key — set by the Phase-4 webhook consumers' at-most-once write. */
  idempotencyKey?: string | null;
  createdAt: Date;
}

export interface AuditLogRow {
  id: string;
  action: string;
  resource: string;
  resourceId: string;
  applicationId?: string | null;
  userId?: string | null;
  details: string | null;
  createdAt: Date;
}

export interface ConversationRow {
  id: string;
  phoneNumber: string;
  appId: string;
  tenantId: string | null;
  providerId: string;
  channel: string;
  status: 'active' | 'closed';
  lastMessageAt: Date;
  updatedAt: Date;
  // Phase 8 ownership fields (mirror packages/database/src/schema/conversations.ts)
  businessNumber?: string | null;
  supplierId?: string | null;
  messagingProfileId?: string | null;
  country?: string | null;
  workflowId?: string | null;
}

// Phase 8: mirrors packages/database/src/schema/inbound-routing.ts
export interface InboundHoldRow {
  id: string;
  dedupeKey: string;
  providerId: string;
  customerPhone: string;
  businessNumber: string | null;
  channel: string;
  content: string;
  keyword: string | null;
  reason: 'ambiguous_owner' | 'no_owner';
  candidates: Array<{ appId: string; tenantId: string; supplierId: string | null; conversationId: string | null }>;
  status: 'pending' | 'resolved' | 'delivered' | 'discarded';
  senderOptOutApplied: boolean;
  rawPayload: unknown;
  resolvedAppId: string | null;
  resolvedTenantId: string | null;
  resolvedSupplierId: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SenderOptOutRow {
  id: string;
  businessNumber: string;
  recipient: string;
  channel: string;
  status: 'opted_out' | 'opted_in';
  source: string;
  keyword: string | null;
  holdId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConsentRow {
  id: string;
  appId: string;
  tenantId: string;
  recipient: string;
  channel: string;
  status: 'opted_in' | 'opted_out' | 'unknown';
  source: 'keyword' | 'api' | 'import';
  keyword: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessagingProfileRow {
  id: string;
  appId: string;
  tenantId: string;
  country: string;
  senderType: string;
  sender: string;
  provider: string;
  campaignId: string | null;
  brandId: string | null;
  complianceStatus: string;
  supplierId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdempotencyRecordRow {
  id: string;
  appId: string;
  tenantId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  result: unknown;
  createdAt: Date;
  expiresAt: Date;
}

export interface WebhookEventRow {
  id: string;
  providerId: string;
  providerEventId: string;
  appId: string | null;
  tenantId: string | null;
  eventType: string | null;
  payload: unknown;
  rawBody: string;
  signature: string | null;
  status: 'received' | 'processing' | 'processed' | 'failed';
  expectedConsumers: string[];
  attempts: number;
  lastError: string | null;
  enqueuedJobs: string[];
  enqueuedAt: Date | null;
  enqueueLeaseUntil: Date | null;
  receivedAt: Date;
  processedAt: Date | null;
  updatedAt: Date;
}

export interface WebhookEventConsumerRow {
  webhookEventId: string;
  consumer: string;
  status: 'processing' | 'processed' | 'failed';
  attempts: number;
  claimToken: string;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  startedAt: Date;
  processedAt: Date | null;
  updatedAt: Date;
}

/**
 * Phase 5: in-memory outbox row (packages/database/src/schema/outbox-events.ts).
 * The simulation models only the operator-facing dead-letter surface
 * (list / replay / counts) — see outboxEventRepository below.
 */
export interface OutboxEventRow {
  id: string;
  appId: string;
  eventType: string;
  payload: unknown;
  status: 'pending' | 'processing' | 'completed' | 'dead';
  createdAt: Date;
  processedAt: Date | null;
  error: string | null;
  attempts: number;
  claimedAt: Date | null;
  claimToken: string | null;
  nextAttemptAt: Date;
  deadAt: Date | null;
  replayCount: number;
  updatedAt: Date;
}

/** Shape of the error Postgres (via the neon/postgres drivers) raises on a unique-index violation. */
export class UniqueViolationError extends Error {
  readonly code = '23505';
  constructor(readonly constraint: string, detail: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`);
    this.name = 'UniqueViolationError';
    (this as unknown as { detail: string }).detail = detail;
  }
}

export interface DbState {
  failEventWrites: boolean;
  failAuditWrites: boolean;
  /** Fault injection: every idempotency-store call throws (DB outage). */
  failIdempotencyStore: boolean;
  /** Fault injection: payment-attempt writes to `transactions` throw (DB outage). */
  failTransactionWrites: boolean;
  /** Fault injection: every webhook_events / webhook_event_consumers call throws (DB outage). */
  failWebhookEventStore: boolean;
  /** Phase 4: durable inbound-webhook receipts, UNIQUE (providerId, providerEventId). */
  webhookEvents: WebhookEventRow[];
  webhookEventConsumers: WebhookEventConsumerRow[];
  /** Phase 5: outbox rows (dead-letter admin surface only; nothing claims them in the simulation). */
  outboxEvents: OutboxEventRow[];
  idempotencyRecords: IdempotencyRecordRow[];
  events: EventRow[];
  auditLogs: AuditLogRow[];
  applications: Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
    environment: string;
  }>;
  apiKeys: Array<{
    id: string;
    keyHash: string;
    applicationId: string;
    environment: string;
    revokedAt: Date | null;
    expiresAt: Date | null;
  }>;
  tenants: Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
    countryCode: string | null;
    currency: string | null;
  }>;
  tenantLinks: Array<{ tenantId: string; applicationId: string; status: string }>;
  conversations: ConversationRow[];
  consentRecords: ConsentRow[];
  messagingProfiles: MessagingProfileRow[];
  inboundHolds: InboundHoldRow[];
  senderOptOuts: SenderOptOutRow[];
  users: UserRow[];
  userSessions: UserSessionRow[];
  userVerificationTokens: UserVerificationTokenRow[];
  roles: RoleRow[];
  plans: PlanRow[];
  subscriptions: SubscriptionRow[];
  customerNotes: CustomerNoteRow[];
  supportTickets: SupportTicketRow[];
  ticketComments: TicketCommentRow[];
  transactions: TransactionRow[];
  checkoutSessions: CheckoutSessionRow[];
  providers: ProviderRow[];
  providerConfigs: ProviderConfigRow[];
  webhookEndpoints: WebhookEndpointRow[];
  suppliers: SupplierRow[];
}

export interface SupplierRow {
  id: string;
  applicationId: string;
  tenantId: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderConfigRow {
  id: string;
  providerId: string;
  environment: string;
  encryptedSecret: string | null;
  secretIv: string | null;
  secretTag: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEndpointRow {
  id: string;
  appId: string;
  tenantId: string;
  url: string;
  encryptedSecret: string;
  secretIv: string;
  secretTag: string;
  eventTypes: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionRow {
  id: string;
  appId: string;
  tenantId: string;
  providerId: string;
  providerTransactionId: string | null;
  status: string;
  amount: string;
  currency: string;
  paymentMethod: string | null;
  idempotencyKey: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  // Phase 6 reconciliation bookkeeping (migration 0016) — optional so
  // pre-existing fixtures that build rows by hand stay valid.
  outcomeUnknownAt?: Date | null;
  reconciliationReason?: string | null;
  reconciliationRequiredAt?: Date | null;
  reconciliationCheckedAt?: Date | null;
  reconciliationCheckCount?: number;
  reconciliationLastCheck?: unknown;
  reconciliationResolvedAt?: Date | null;
  reconciliationResolution?: unknown;
}

/**
 * Mirrors repositories/transactions.ts transitionStatus(): the conditional
 * UPDATE ... WHERE status = ANY(<allowed prior statuses>) — applied in one
 * synchronous step (no await between check and write), so it has the same
 * all-or-nothing semantics in this single-threaded double.
 */
function simTransitionStatus(id: string, to: string, opts: Record<string, any> = {}) {
  if (!TX_VALID_STATUSES.has(to)) throw new Error(`Invalid transaction status: ${to}`);
  if (dbState.failTransactionWrites) throw new Error('simulated transactions write failure');
  const allowedFrom = transactionStatusesAllowedInto(to).filter((f) => !opts.from || opts.from.includes(f));
  const row = dbState.transactions.find((t) => t.id === id);
  if (!row) return { outcome: 'not_found' as const };
  if (!allowedFrom.includes(row.status)) return { outcome: 'rejected' as const, currentStatus: row.status, transaction: row as any };
  const wasAmbiguous = (TX_AMBIGUOUS_STATUSES as readonly string[]).includes(row.status);
  const toAmbiguous = (TX_AMBIGUOUS_STATUSES as readonly string[]).includes(to);
  if (opts.providerId !== undefined) row.providerId = String(opts.providerId);
  if (opts.providerTransactionId !== undefined) row.providerTransactionId = opts.providerTransactionId ? String(opts.providerTransactionId) : null;
  if (opts.fillProviderTransactionId && !row.providerTransactionId) row.providerTransactionId = String(opts.fillProviderTransactionId);
  if (opts.amount !== undefined) row.amount = String(opts.amount);
  if (opts.currency !== undefined) row.currency = String(opts.currency);
  if (opts.metadata !== undefined) row.metadata = opts.metadata;
  if (opts.reconciliationReason !== undefined) row.reconciliationReason = opts.reconciliationReason;
  if (toAmbiguous) {
    row.outcomeUnknownAt = row.outcomeUnknownAt ?? new Date();
    if (to === 'requires_reconciliation') row.reconciliationRequiredAt = row.reconciliationRequiredAt ?? new Date();
  } else if (opts.resolution) {
    row.reconciliationResolvedAt = new Date();
    row.reconciliationResolution = opts.resolution;
  } else if (wasAmbiguous) {
    row.reconciliationResolvedAt = new Date();
  }
  row.status = to;
  row.updatedAt = new Date();
  return { outcome: 'applied' as const, transaction: row as any };
}

export interface CheckoutSessionRow {
  id: string;
  token: string;
  appId: string;
  tenantId: string;
  amount: string;
  currency: string;
  status: string;
  successUrl: string | null;
  cancelUrl: string | null;
  paymentEventId: string | null;
  metadata: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface CustomerNoteRow {
  id: string;
  applicationId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface SupportTicketRow {
  id: string;
  applicationId: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  requesterEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export interface TicketCommentRow {
  id: string;
  ticketId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface PlanRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  interval: string;
  messageLimit: number | null;
  paymentVolumeLimitCents: number | null;
  stripePriceId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionRow {
  id: string;
  applicationId: string;
  planId: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRow {
  id: string;
  applicationId: string;
  tenantId: string | null;
  roleId: string | null;
  email: string;
  name: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  failedLoginAttempts: number;
  lockedUntilAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface UserVerificationTokenRow {
  id: string;
  userId: string;
  purpose: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface RoleRow {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  isSystem: string;
  createdAt: Date;
  updatedAt: Date;
}

export const dbState: DbState = {
  failEventWrites: false,
  failAuditWrites: false,
  failIdempotencyStore: false,
  failTransactionWrites: false,
  failWebhookEventStore: false,
  webhookEvents: [],
  webhookEventConsumers: [],
  outboxEvents: [],
  idempotencyRecords: [],
  events: [],
  auditLogs: [],
  applications: [],
  apiKeys: [],
  tenants: [],
  tenantLinks: [],
  conversations: [],
  consentRecords: [],
  messagingProfiles: [],
  inboundHolds: [],
  senderOptOuts: [],
  users: [],
  userSessions: [],
  userVerificationTokens: [],
  roles: [],
  plans: [],
  subscriptions: [],
  customerNotes: [],
  supportTickets: [],
  ticketComments: [],
  transactions: [],
  checkoutSessions: [],
  providers: [],
  providerConfigs: [],
  webhookEndpoints: [],
  suppliers: [],
};

export const APP_SLUG = 'reach-church';
export const APP_NAME = 'Reach Church';
export const API_KEY = 'bap_test_reachchurch_0001';
export const TENANT_ID = 'ten_reach_church';
export const OTHER_TENANT_ID = 'ten_unrelated';

// A second, fully separate application + tenant used to prove cross-tenant
// isolation breaks (IDOR, tenant escape, conversation bleed) without relying on
// the non-production auth bypass.
export const OTHER_APP_SLUG = 'haulpro';
export const OTHER_APP_NAME = 'HaulPro Logistics';
export const OTHER_API_KEY = 'bap_test_haulpro_0001';
export const OTHER_TENANT_ID_HAULPRO = 'ten_haulpro';
export const OTHER_DONOR_EMAIL = 'shipper@haulpro.example';
export const OTHER_DONOR_PHONE = '+15550002222';

// Third, independent application (social network) used for Application
// Integration Certification (Audit 7).
export const AFRIBOOK_SLUG = 'afribook';
export const AFRIBOOK_NAME = 'Afribook Social';
export const AFRIBOOK_API_KEY = 'bap_test_afribook_0001';
export const AFRIBOOK_TENANT_ID = 'ten_afribook';
export const AFRIBOOK_DONOR_EMAIL = 'member@afribook.example';
export const AFRIBOOK_DONOR_PHONE = '+15550003333';

export const DONOR_EMAIL = 'donor@reach.example';
export const DONOR_PHONE = '+15550001111';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Defined at module scope (not inline in the mock's returned object
// literal) so AuthRegistry's methods below can throw instances of the
// exact same classes the mock exports as AuthError/ValidationError/
// ConflictError — object-literal properties can't reference their
// siblings while the literal itself is being constructed.
class MockAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
class MockValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
class MockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
class MockSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}
class MockCrmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmError';
  }
}

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const INTERVAL_MS: Record<string, number> = {
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

export function clearDb(): void {
  dbState.failEventWrites = false;
  dbState.failAuditWrites = false;
  dbState.failIdempotencyStore = false;
  dbState.failTransactionWrites = false;
  dbState.failWebhookEventStore = false;
  dbState.webhookEvents = [];
  dbState.webhookEventConsumers = [];
  dbState.outboxEvents = [];
  dbState.idempotencyRecords = [];
  dbState.events = [];
  dbState.auditLogs = [];
  dbState.applications = [];
  dbState.apiKeys = [];
  dbState.tenants = [];
  dbState.tenantLinks = [];
  dbState.conversations = [];
  dbState.consentRecords = [];
  dbState.messagingProfiles = [];
  dbState.inboundHolds = [];
  dbState.senderOptOuts = [];
  dbState.users = [];
  dbState.userSessions = [];
  dbState.userVerificationTokens = [];
  dbState.roles = [];
  dbState.plans = [];
  dbState.subscriptions = [];
  dbState.customerNotes = [];
  dbState.supportTickets = [];
  dbState.ticketComments = [];
  dbState.transactions = [];
  dbState.checkoutSessions = [];
  dbState.providers = [];
  dbState.providerConfigs = [];
  dbState.webhookEndpoints = [];
  dbState.suppliers = [];
}

// Mirrors the seed plans inserted by migration 0011_add_subscriptions.sql
// against the real database — opt-in (like seedReachChurch()) since most
// simulation suites don't exercise billing at all.
export function seedPlans(): void {
  const now = new Date();
  dbState.plans.push(
    {
      id: 'plan_starter',
      slug: 'starter',
      name: 'Starter',
      description: 'Free tier for evaluating the platform.',
      priceCents: 0,
      currency: 'USD',
      interval: 'month',
      messageLimit: 1000,
      paymentVolumeLimitCents: 500_000,
      stripePriceId: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'plan_growth',
      slug: 'growth',
      name: 'Growth',
      description: 'For applications with active production traffic.',
      priceCents: 4900,
      currency: 'USD',
      interval: 'month',
      messageLimit: 25_000,
      paymentVolumeLimitCents: 5_000_000,
      stripePriceId: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'plan_enterprise',
      slug: 'enterprise',
      name: 'Enterprise',
      description: 'Unlimited usage, dedicated support.',
      priceCents: 19_900,
      currency: 'USD',
      interval: 'month',
      messageLimit: null,
      paymentVolumeLimitCents: null,
      stripePriceId: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
  );
}

export function seedReachChurch(): void {
  dbState.applications.push({
    id: `app_${APP_SLUG}`,
    slug: APP_SLUG,
    name: APP_NAME,
    status: 'active',
    environment: 'development',
  });
  dbState.apiKeys.push({
    id: 'key_reach_church_1',
    keyHash: sha256(API_KEY),
    applicationId: `app_${APP_SLUG}`,
    environment: 'development',
    revokedAt: null,
    expiresAt: null,
  });
  dbState.tenants.push({
    id: TENANT_ID,
    slug: APP_SLUG,
    name: APP_NAME,
    status: 'active',
    countryCode: 'US',
    currency: 'USD',
  });
  dbState.tenants.push({
    id: OTHER_TENANT_ID,
    slug: 'unrelated-church',
    name: 'Unrelated Church',
    status: 'active',
    countryCode: 'US',
    currency: 'USD',
  });
  dbState.tenantLinks.push({
    tenantId: TENANT_ID,
    // Real tenant_application_links.application_id is a UUID FK to
    // applications.id, not the slug — match that here so isLinked() checks
    // exercise the same appId-resolution path as production.
    applicationId: `app_${APP_SLUG}`,
    status: 'active',
  });

  // Second, independent application + tenant (HaulPro Logistics).
  dbState.applications.push({
    id: `app_${OTHER_APP_SLUG}`,
    slug: OTHER_APP_SLUG,
    name: OTHER_APP_NAME,
    status: 'active',
    environment: 'development',
  });
  dbState.apiKeys.push({
    id: 'key_haulpro_1',
    keyHash: sha256(OTHER_API_KEY),
    applicationId: `app_${OTHER_APP_SLUG}`,
    environment: 'development',
    revokedAt: null,
    expiresAt: null,
  });
  dbState.tenants.push({
    id: OTHER_TENANT_ID_HAULPRO,
    slug: OTHER_APP_SLUG,
    name: OTHER_APP_NAME,
    status: 'active',
    countryCode: 'US',
    currency: 'USD',
  });
  dbState.tenantLinks.push({
    tenantId: OTHER_TENANT_ID_HAULPRO,
    applicationId: `app_${OTHER_APP_SLUG}`,
    status: 'active',
  });

  // Third independent application (Afribook Social).
  dbState.applications.push({
    id: `app_${AFRIBOOK_SLUG}`,
    slug: AFRIBOOK_SLUG,
    name: AFRIBOOK_NAME,
    status: 'active',
    environment: 'development',
  });
  dbState.apiKeys.push({
    id: 'key_afribook_1',
    keyHash: sha256(AFRIBOOK_API_KEY),
    applicationId: `app_${AFRIBOOK_SLUG}`,
    environment: 'development',
    revokedAt: null,
    expiresAt: null,
  });
  dbState.tenants.push({
    id: AFRIBOOK_TENANT_ID,
    slug: AFRIBOOK_SLUG,
    name: AFRIBOOK_NAME,
    status: 'active',
    countryCode: 'US',
    currency: 'USD',
  });
  dbState.tenantLinks.push({
    tenantId: AFRIBOOK_TENANT_ID,
    applicationId: `app_${AFRIBOOK_SLUG}`,
    status: 'active',
  });
}

export function countRows(predicate: (row: EventRow) => boolean): number {
  return dbState.events.filter(predicate).length;
}

function normalizeRow(data: Record<string, unknown>): EventRow {
  return {
    id: `evt_${randomUUID().slice(0, 12)}`,
    appId: String(data.appId ?? 'system'),
    category: String(data.category ?? 'event'),
    providerId: data.providerId != null ? String(data.providerId) : null,
    status: data.status != null ? String(data.status) : null,
    amount: data.amount != null ? String(data.amount) : null,
    currency: data.currency != null ? String(data.currency) : null,
    latency: data.latency != null ? Number(data.latency) : null,
    cost: data.cost != null ? String(data.cost) : null,
    decisionReason: data.decisionReason != null ? String(data.decisionReason) : null,
    payload: data.payload ?? null,
    response: data.response ?? null,
    error: data.error != null ? String(data.error) : null,
    idempotencyKey: data.idempotencyKey != null ? String(data.idempotencyKey) : null,
    createdAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Mock implementation of the '@company/database' entry module.
// Must supply everything the gateway + worker import at runtime:
//   eventRepository, auditLogRepository, applicationRepository,
//   apiKeyRepository, tenantRepository, tenantApplicationLinkRepository,
//   conversationRepository,
//   ApplicationRegistry, TenantRegistry, checkDatabaseHealth
// ---------------------------------------------------------------------------

export function installDatabaseMock(): Record<string, unknown> {
  return {
    transactionStatusesAllowedInto,
    paymentOutcomeFromEvent,
    DEFAULT_OUTBOX_RETRY_POLICY,
    DEFAULT_OUTBOX_STALE_AFTER_MS,
    SupplierScope,
    isUuid,
    normalizeMessagingAddress,
    channelFromAddress,
    eventRepository: {
      async create(data: Record<string, unknown>): Promise<EventRow> {
        if (dbState.failEventWrites) {
          throw new Error('database unavailable (simulated): connection refused');
        }
        const row = normalizeRow(data);
        dbState.events.push(row);
        return row;
      },
      async countByCategory(appId?: string): Promise<Record<string, number>> {
        if (dbState.failEventWrites) {
          throw new Error('database unavailable (simulated): connection refused');
        }
        const out: Record<string, number> = {};
        for (const e of dbState.events) {
          if (appId && e.appId !== appId) continue;
          out[e.category] = (out[e.category] ?? 0) + 1;
        }
        return out;
      },
      async countSince(since: Date, appId?: string): Promise<number> {
        return dbState.events.filter((e) => e.createdAt >= since && (!appId || e.appId === appId)).length;
      },
      // Plan message-limit enforcement — mirrors
      // packages/database/src/repositories/events.ts's real
      // implementation (count only 'success' rows in one category since
      // a given time).
      async countSuccessfulByCategorySince(appId: string, category: string, since: Date): Promise<number> {
        return dbState.events.filter(
          (e) => e.appId === appId && e.category === category && e.status === 'success' && e.createdAt >= since,
        ).length;
      },
      async findLatest(limit = 100, appId?: string): Promise<EventRow[]> {
        let events = dbState.events;
        if (appId) events = events.filter((e) => e.appId === appId);
        return events.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
      },
      async findByAppId(appId: string, limit = 100): Promise<EventRow[]> {
        return dbState.events.filter((e) => e.appId === appId).slice(0, limit);
      },
    },
    auditLogRepository: {
      async create(data: Record<string, unknown>): Promise<AuditLogRow> {
        if (dbState.failAuditWrites) {
          throw new Error('database unavailable (simulated): connection refused');
        }
        const row: AuditLogRow = {
          id: `aud_${randomUUID().slice(0, 12)}`,
          action: String(data.action ?? 'unknown'),
          resource: String(data.resource ?? ''),
          resourceId: String(data.resourceId ?? ''),
          applicationId: data.applicationId != null ? String(data.applicationId) : null,
          userId: data.userId != null ? String(data.userId) : null,
          details: data.details != null ? String(data.details) : null,
          createdAt: new Date(),
        };
        dbState.auditLogs.push(row);
        return row;
      },
      async count(): Promise<number> {
        return dbState.auditLogs.length;
      },
      async findRecent(applicationId?: string, limit = 50): Promise<AuditLogRow[]> {
        let logs = dbState.auditLogs;
        if (applicationId) logs = logs.filter((a) => a.applicationId === applicationId);
        return logs.slice(0, limit);
      },
      async findByAction(applicationId: string, action: string, limit = 100): Promise<AuditLogRow[]> {
        return dbState.auditLogs.filter((a) => a.applicationId === applicationId && a.action === action).slice(0, limit);
      },
      async findByApplicationId(applicationId: string, limit = 100): Promise<AuditLogRow[]> {
        return dbState.auditLogs.filter((a) => a.applicationId === applicationId).slice(0, limit);
      },
      async findByUserId(userId: string, limit = 100): Promise<AuditLogRow[]> {
        return dbState.auditLogs.filter((a) => a.userId === userId).slice(0, limit);
      },
    },
    applicationRepository: {
      async findById(id: string) {
        const row = dbState.applications.find((a) => a.id === id);
        return row ? { ...row, createdAt: (row as any).createdAt ?? new Date() } : undefined;
      },
      async findBySlug(slug: string) {
        return dbState.applications.find((a) => a.slug === slug);
      },
      async findByName(name: string) {
        return dbState.applications.find((a) => a.name === name);
      },
      // Applications created before this CRM work don't have createdAt at
      // all (see DbState.applications' type) — default it here rather
      // than touching every existing creation call site (seedReachChurch,
      // the ApplicationRegistry/AuthRegistry mocks' own app-creation
      // paths) just to satisfy the CRM's display-only need for a value.
      async findAll() {
        return dbState.applications.map((a) => ({ ...a, createdAt: (a as any).createdAt ?? new Date() }));
      },
      async create(data: Record<string, unknown>) {
        const row = { id: `app_${randomUUID().slice(0, 8)}`, slug: String(data.slug), name: String(data.name), status: 'active', environment: 'development', createdAt: new Date() };
        dbState.applications.push(row);
        return row;
      },
      async update(_id: string, data: Partial<Record<string, unknown>>) {
        const row = dbState.applications.find((a) => a.id === _id);
        if (!row) return undefined;
        Object.assign(row, data);
        return row;
      },
    },
    apiKeyRepository: {
      async findByHash(keyHash: string) {
        return dbState.apiKeys.find((k) => k.keyHash === keyHash);
      },
      async findById(id: string) {
        return dbState.apiKeys.find((k) => k.id === id);
      },
      async findByApplicationId(applicationId: string) {
        return dbState.apiKeys.filter((k) => k.applicationId === applicationId);
      },
      async create(data: Record<string, unknown>) {
        const row = { id: `key_${randomUUID().slice(0, 8)}`, keyHash: String(data.keyHash), applicationId: String(data.applicationId), environment: 'development', revokedAt: null, expiresAt: null };
        dbState.apiKeys.push(row);
        return row;
      },
      async revoke(id: string) {
        const row = dbState.apiKeys.find((k) => k.id === id);
        if (!row) return undefined;
        row.revokedAt = new Date();
        return row;
      },
      async updateLastUsed(_id: string): Promise<void> {
        // no-op in simulation
      },
    },
    userRepository: {
      async findByEmail(email: string) {
        return dbState.users.find((u) => u.email === email);
      },
      async findById(id: string) {
        return dbState.users.find((u) => u.id === id);
      },
      async findByApplicationAndEmail(applicationId: string, email: string) {
        return dbState.users.find((u) => u.applicationId === applicationId && u.email === email);
      },
      async findByApplicationId(applicationId: string) {
        return dbState.users.filter((u) => u.applicationId === applicationId);
      },
      async create(data: Record<string, unknown>) {
        const row: UserRow = {
          id: `user_${randomUUID().slice(0, 8)}`,
          applicationId: String(data.applicationId),
          tenantId: (data.tenantId as string) ?? null,
          roleId: (data.roleId as string) ?? null,
          email: String(data.email),
          name: (data.name as string) ?? null,
          passwordHash: (data.passwordHash as string) ?? null,
          emailVerifiedAt: null,
          lastLoginAt: null,
          failedLoginAttempts: 0,
          lockedUntilAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.users.push(row);
        return row;
      },
      async update(id: string, data: Partial<Record<string, unknown>>) {
        const row = dbState.users.find((u) => u.id === id);
        if (!row) return undefined;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      async incrementFailedLoginAttempts(id: string) {
        const row = dbState.users.find((u) => u.id === id);
        if (!row) return undefined;
        row.failedLoginAttempts += 1;
        return row;
      },
      async count() {
        return dbState.users.length;
      },
    },
    userSessionRepository: {
      async findByTokenHash(tokenHash: string) {
        return dbState.userSessions.find((s) => s.tokenHash === tokenHash);
      },
      async findActiveByUserId(userId: string) {
        return dbState.userSessions.filter((s) => s.userId === userId && !s.revokedAt);
      },
      async create(data: Record<string, unknown>) {
        const row: UserSessionRow = {
          id: `usess_${randomUUID().slice(0, 8)}`,
          userId: String(data.userId),
          tokenHash: String(data.tokenHash),
          userAgent: (data.userAgent as string) ?? null,
          ipAddress: (data.ipAddress as string) ?? null,
          expiresAt: data.expiresAt as Date,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
        };
        dbState.userSessions.push(row);
        return row;
      },
      async revoke(id: string) {
        const row = dbState.userSessions.find((s) => s.id === id);
        if (!row) return undefined;
        row.revokedAt = new Date();
        return row;
      },
      async revokeAllForUser(userId: string) {
        for (const s of dbState.userSessions) {
          if (s.userId === userId && !s.revokedAt) s.revokedAt = new Date();
        }
      },
      async updateLastUsed(id: string) {
        const row = dbState.userSessions.find((s) => s.id === id);
        if (row) row.lastUsedAt = new Date();
      },
    },
    userVerificationTokenRepository: {
      async findByTokenHash(tokenHash: string) {
        return dbState.userVerificationTokens.find((t) => t.tokenHash === tokenHash);
      },
      async create(data: Record<string, unknown>) {
        const row: UserVerificationTokenRow = {
          id: `uvt_${randomUUID().slice(0, 8)}`,
          userId: String(data.userId),
          purpose: String(data.purpose),
          tokenHash: String(data.tokenHash),
          expiresAt: data.expiresAt as Date,
          usedAt: null,
          createdAt: new Date(),
        };
        dbState.userVerificationTokens.push(row);
        return row;
      },
      async markUsed(id: string) {
        const row = dbState.userVerificationTokens.find((t) => t.id === id);
        if (!row) return undefined;
        row.usedAt = new Date();
        return row;
      },
      async invalidateOutstanding(userId: string, purpose: string) {
        for (const t of dbState.userVerificationTokens) {
          if (t.userId === userId && t.purpose === purpose && !t.usedAt) t.usedAt = new Date();
        }
      },
    },
    roleRepository: {
      async findById(id: string) {
        return dbState.roles.find((r) => r.id === id);
      },
      async findByApplicationAndName(applicationId: string, name: string) {
        return dbState.roles.find((r) => r.applicationId === applicationId && r.name === name);
      },
      async findByApplicationId(applicationId: string) {
        return dbState.roles.filter((r) => r.applicationId === applicationId);
      },
      async create(data: Record<string, unknown>) {
        const row: RoleRow = {
          id: `role_${randomUUID().slice(0, 8)}`,
          applicationId: String(data.applicationId),
          name: String(data.name),
          description: (data.description as string) ?? null,
          isSystem: (data.isSystem as string) ?? 'false',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.roles.push(row);
        return row;
      },
      async addPermission(data: Record<string, unknown>) {
        return { id: `perm_${randomUUID().slice(0, 8)}`, ...data };
      },
      async findPermissionsByRoleId(_roleId: string) {
        return [];
      },
    },
    planRepository: {
      async findById(id: string) {
        return dbState.plans.find((p) => p.id === id);
      },
      async findBySlug(slug: string) {
        return dbState.plans.find((p) => p.slug === slug);
      },
      async listActive() {
        return dbState.plans.filter((p) => p.isActive);
      },
      async list() {
        return dbState.plans;
      },
      async create(data: Record<string, unknown>) {
        const row: PlanRow = {
          id: `plan_${randomUUID().slice(0, 8)}`,
          slug: String(data.slug),
          name: String(data.name),
          description: (data.description as string) ?? null,
          priceCents: Number(data.priceCents),
          currency: (data.currency as string) ?? 'USD',
          interval: (data.interval as string) ?? 'month',
          messageLimit: (data.messageLimit as number) ?? null,
          paymentVolumeLimitCents: (data.paymentVolumeLimitCents as number) ?? null,
          stripePriceId: (data.stripePriceId as string) ?? null,
          isActive: (data.isActive as boolean) ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.plans.push(row);
        return row;
      },
      async update(id: string, data: Partial<Record<string, unknown>>) {
        const row = dbState.plans.find((p) => p.id === id);
        if (!row) return undefined;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    subscriptionRepository: {
      async findById(id: string) {
        return dbState.subscriptions.find((s) => s.id === id);
      },
      async findByApplicationId(applicationId: string) {
        return dbState.subscriptions.find((s) => s.applicationId === applicationId);
      },
      async findByStripeSubscriptionId(stripeSubscriptionId: string) {
        return dbState.subscriptions.find((s) => s.stripeSubscriptionId === stripeSubscriptionId);
      },
      async create(data: Record<string, unknown>) {
        const row: SubscriptionRow = {
          id: `subx_${randomUUID().slice(0, 8)}`,
          applicationId: String(data.applicationId),
          planId: String(data.planId),
          status: (data.status as string) ?? 'active',
          stripeCustomerId: (data.stripeCustomerId as string) ?? null,
          stripeSubscriptionId: (data.stripeSubscriptionId as string) ?? null,
          currentPeriodStart: (data.currentPeriodStart as Date) ?? null,
          currentPeriodEnd: (data.currentPeriodEnd as Date) ?? null,
          cancelAtPeriodEnd: (data.cancelAtPeriodEnd as boolean) ?? false,
          canceledAt: (data.canceledAt as Date) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.subscriptions.push(row);
        return row;
      },
      async update(id: string, data: Partial<Record<string, unknown>>) {
        const row = dbState.subscriptions.find((s) => s.id === id);
        if (!row) return undefined;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    customerNoteRepository: {
      async findByApplicationId(applicationId: string) {
        return dbState.customerNotes.filter((n) => n.applicationId === applicationId);
      },
      async create(data: Record<string, unknown>) {
        const row: CustomerNoteRow = {
          id: `note_${randomUUID().slice(0, 8)}`,
          applicationId: String(data.applicationId),
          authorName: String(data.authorName),
          body: String(data.body),
          createdAt: new Date(),
        };
        dbState.customerNotes.push(row);
        return row;
      },
    },
    supportTicketRepository: {
      async findById(id: string) {
        return dbState.supportTickets.find((t) => t.id === id);
      },
      async findByApplicationId(applicationId: string) {
        return dbState.supportTickets.filter((t) => t.applicationId === applicationId);
      },
      async findAll(status?: string) {
        return status ? dbState.supportTickets.filter((t) => t.status === status) : dbState.supportTickets;
      },
      async countOpenByApplicationId(applicationId: string) {
        return dbState.supportTickets.filter((t) => t.applicationId === applicationId && t.status === 'open').length;
      },
      async create(data: Record<string, unknown>) {
        const row: SupportTicketRow = {
          id: `ticket_${randomUUID().slice(0, 8)}`,
          applicationId: String(data.applicationId),
          subject: String(data.subject),
          description: String(data.description),
          status: (data.status as string) ?? 'open',
          priority: (data.priority as string) ?? 'normal',
          requesterEmail: (data.requesterEmail as string) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          resolvedAt: null,
        };
        dbState.supportTickets.push(row);
        return row;
      },
      async update(id: string, data: Partial<Record<string, unknown>>) {
        const row = dbState.supportTickets.find((t) => t.id === id);
        if (!row) return undefined;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    ticketCommentRepository: {
      async findByTicketId(ticketId: string) {
        return dbState.ticketComments.filter((c) => c.ticketId === ticketId);
      },
      async create(data: Record<string, unknown>) {
        const row: TicketCommentRow = {
          id: `comment_${randomUUID().slice(0, 8)}`,
          ticketId: String(data.ticketId),
          authorName: String(data.authorName),
          body: String(data.body),
          createdAt: new Date(),
        };
        dbState.ticketComments.push(row);
        return row;
      },
    },
    tenantRepository: {
      async findById(id: string) {
        return dbState.tenants.find((t) => t.id === id);
      },
      async findBySlug(slug: string) {
        return dbState.tenants.find((t) => t.slug === slug);
      },
      async create(data: Record<string, unknown>) {
        const row = { id: `ten_${randomUUID().slice(0, 8)}`, slug: String(data.slug), name: String(data.name), status: 'active', countryCode: null, currency: null };
        dbState.tenants.push(row);
        return row;
      },
      async update(_id: string, data: Partial<Record<string, unknown>>) {
        const row = dbState.tenants.find((t) => t.id === _id);
        if (!row) return undefined;
        Object.assign(row, data);
        return row;
      },
    },
    tenantApplicationLinkRepository: {
      async findByTenantAndApplication(tenantId: string, applicationId: string) {
        return dbState.tenantLinks.find((l) => l.tenantId === tenantId && l.applicationId === applicationId);
      },
      async isLinked(tenantId: string, applicationId: string) {
        return dbState.tenantLinks.some((l) => l.tenantId === tenantId && l.applicationId === applicationId);
      },
      async link(tenantId: string, applicationId: string) {
        const row = { tenantId, applicationId, status: 'active' };
        dbState.tenantLinks.push(row);
        return row;
      },
      async unlink(tenantId: string, applicationId: string) {
        const before = dbState.tenantLinks.length;
        dbState.tenantLinks = dbState.tenantLinks.filter((l) => !(l.tenantId === tenantId && l.applicationId === applicationId));
        return dbState.tenantLinks.length < before;
      },
    },
    conversationRepository: {
      // Phase 8: mirrors packages/database/src/repositories/conversations.ts —
      // normalised customer number, ownership key (phone, business number,
      // app, tenant, supplier) with NULLs not distinct, legacy adoption.
      async findByPhoneAndApp(
        phoneNumber: string,
        appId: string,
        tenantId: string = 'default',
      ): Promise<ConversationRow | undefined> {
        const phone = normalizeMessagingAddress(phoneNumber);
        return dbState.conversations
          .filter((c) => c.phoneNumber === phone && c.appId === appId && c.tenantId === tenantId)
          .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())[0];
      },
      async findActiveForOwner(
        phoneNumber: string,
        owner: { appId: string; tenantId: string; supplierId?: string | null },
      ): Promise<ConversationRow[]> {
        const phone = normalizeMessagingAddress(phoneNumber);
        return dbState.conversations
          .filter(
            (c) =>
              c.phoneNumber === phone &&
              c.appId === owner.appId &&
              c.tenantId === owner.tenantId &&
              (c.supplierId ?? null) === (owner.supplierId ?? null) &&
              c.status === 'active',
          )
          .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
      },
      async findActiveByPhone(phoneNumber: string): Promise<ConversationRow[]> {
        const phone = normalizeMessagingAddress(phoneNumber);
        return dbState.conversations
          .filter((c) => c.phoneNumber === phone && c.status === 'active')
          .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
      },
      async upsert(
        phoneNumber: string,
        appId: string,
        data: {
          providerId: string;
          channel: string;
          tenantId: string;
          supplierId?: string | null;
          businessNumber?: string | null;
          messagingProfileId?: string | null;
          country?: string | null;
          workflowId?: string | null;
        },
      ): Promise<ConversationRow> {
        const phone = normalizeMessagingAddress(phoneNumber);
        const businessNumber = normalizeMessagingAddress(data.businessNumber ?? '') || null;
        const supplierId = data.supplierId || null;
        const sameOwner = (c: ConversationRow) =>
          c.phoneNumber === phone && c.appId === appId && c.tenantId === data.tenantId && (c.supplierId ?? null) === supplierId;
        let existing = dbState.conversations.find((c) => sameOwner(c) && (c.businessNumber ?? null) === businessNumber);
        if (!existing && businessNumber) {
          // Legacy adoption (see the real repository).
          existing = dbState.conversations.find((c) => sameOwner(c) && (c.businessNumber ?? null) === null);
          if (existing) existing.businessNumber = businessNumber;
        }
        const apply = (row: ConversationRow) => {
          if (data.messagingProfileId !== undefined) row.messagingProfileId = data.messagingProfileId;
          if (data.country !== undefined) row.country = data.country;
          if (data.workflowId !== undefined) row.workflowId = data.workflowId;
        };
        if (existing) {
          existing.providerId = data.providerId;
          existing.channel = data.channel;
          existing.status = 'active';
          existing.lastMessageAt = new Date();
          existing.updatedAt = new Date();
          apply(existing);
          return existing;
        }
        const row: ConversationRow = {
          id: `conv_${randomUUID().slice(0, 12)}`,
          phoneNumber: phone,
          appId,
          tenantId: data.tenantId,
          providerId: data.providerId,
          channel: data.channel,
          status: 'active',
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          businessNumber,
          supplierId,
          messagingProfileId: null,
          country: null,
          workflowId: null,
        };
        apply(row);
        dbState.conversations.push(row);
        return row;
      },
      async touch(id: string): Promise<void> {
        const row = dbState.conversations.find((c) => c.id === id);
        if (row) {
          row.lastMessageAt = new Date();
          row.updatedAt = new Date();
        }
      },
      // P1-2 FIX: Include tenantId in close to match real repository behavior.
      async close(
        phoneNumber: string,
        appId: string,
        tenantId: string = 'default',
      ): Promise<boolean> {
        const phone = normalizeMessagingAddress(phoneNumber);
        const rows = dbState.conversations.filter(
          (c) => c.phoneNumber === phone && c.appId === appId && c.tenantId === tenantId,
        );
        for (const existing of rows) {
          existing.status = 'closed';
          existing.updatedAt = new Date();
        }
        return rows.length > 0;
      },
      async count(): Promise<number> {
        return dbState.conversations.length;
      },
    },
    // Phase 8: mirrors packages/database/src/repositories/inbound-routing.ts
    inboundMessageHoldRepository: {
      async createOrGet(data: Omit<InboundHoldRow, 'id' | 'status' | 'senderOptOutApplied' | 'resolvedAppId' | 'resolvedTenantId' | 'resolvedSupplierId' | 'resolvedBy' | 'resolutionNote' | 'resolvedAt' | 'deliveredAt' | 'createdAt' | 'updatedAt' | 'rawPayload'> & { rawPayload?: unknown }) {
        const existing = dbState.inboundHolds.find((h) => h.dedupeKey === data.dedupeKey);
        if (existing) return { hold: existing, created: false };
        const row: InboundHoldRow = {
          id: randomUUID(),
          dedupeKey: data.dedupeKey,
          providerId: data.providerId,
          customerPhone: normalizeMessagingAddress(data.customerPhone),
          businessNumber: data.businessNumber ? normalizeMessagingAddress(data.businessNumber) : null,
          channel: data.channel,
          content: data.content,
          keyword: data.keyword,
          reason: data.reason,
          candidates: [...data.candidates],
          status: 'pending',
          senderOptOutApplied: false,
          rawPayload: data.rawPayload ?? null,
          resolvedAppId: null,
          resolvedTenantId: null,
          resolvedSupplierId: null,
          resolvedBy: null,
          resolutionNote: null,
          resolvedAt: null,
          deliveredAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.inboundHolds.push(row);
        return { hold: row, created: true };
      },
      async findById(id: string) {
        return dbState.inboundHolds.find((h) => h.id === id);
      },
      async markSenderOptOutApplied(id: string) {
        const row = dbState.inboundHolds.find((h) => h.id === id);
        if (row) row.senderOptOutApplied = true;
      },
      async list(opts: { status?: string; limit?: number } = {}) {
        return dbState.inboundHolds
          .filter((h) => !opts.status || h.status === opts.status)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, opts.limit ?? 100);
      },
      async countByStatus() {
        const out: Record<string, number> = {};
        for (const h of dbState.inboundHolds) out[h.status] = (out[h.status] ?? 0) + 1;
        return out;
      },
      async resolve(
        id: string,
        owner: { appId: string; tenantId: string; supplierId?: string | null },
        meta: { resolvedBy: string; note: string },
      ) {
        const row = dbState.inboundHolds.find((h) => h.id === id);
        if (!row) return { outcome: 'not_found' as const };
        if (row.status !== 'pending') return { outcome: 'not_pending' as const, status: row.status };
        const ok = row.candidates.some(
          (c) => c.appId === owner.appId && c.tenantId === owner.tenantId && (c.supplierId ?? null) === (owner.supplierId ?? null),
        );
        if (!ok) return { outcome: 'not_a_candidate' as const, candidates: row.candidates };
        row.status = 'resolved';
        row.resolvedAppId = owner.appId;
        row.resolvedTenantId = owner.tenantId;
        row.resolvedSupplierId = owner.supplierId ?? null;
        row.resolvedBy = meta.resolvedBy;
        row.resolutionNote = meta.note;
        row.resolvedAt = new Date();
        row.updatedAt = new Date();
        return { outcome: 'resolved' as const, hold: row };
      },
      async discard(id: string, meta: { resolvedBy: string; note: string }) {
        const row = dbState.inboundHolds.find((h) => h.id === id && h.status === 'pending');
        if (!row) return undefined;
        row.status = 'discarded';
        row.resolvedBy = meta.resolvedBy;
        row.resolutionNote = meta.note;
        row.resolvedAt = new Date();
        return row;
      },
      async markDelivered(id: string) {
        const row = dbState.inboundHolds.find((h) => h.id === id && h.status === 'resolved');
        if (!row) return false;
        row.status = 'delivered';
        row.deliveredAt = new Date();
        return true;
      },
    },
    senderOptOutRepository: {
      async upsert(data: {
        businessNumber: string;
        recipient: string;
        channel: string;
        status: 'opted_out' | 'opted_in';
        source: string;
        keyword?: string | null;
        holdId?: string | null;
      }) {
        const businessNumber = normalizeMessagingAddress(data.businessNumber);
        const recipient = normalizeMessagingAddress(data.recipient);
        let row = dbState.senderOptOuts.find(
          (o) => o.businessNumber === businessNumber && o.recipient === recipient && o.channel === data.channel,
        );
        if (row) {
          row.status = data.status;
          row.source = data.source;
          row.keyword = data.keyword ?? null;
          row.holdId = data.holdId ?? null;
          row.updatedAt = new Date();
        } else {
          row = {
            id: randomUUID(),
            businessNumber,
            recipient,
            channel: data.channel,
            status: data.status,
            source: data.source,
            keyword: data.keyword ?? null,
            holdId: data.holdId ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbState.senderOptOuts.push(row);
        }
        return row;
      },
      async find(businessNumber: string, recipient: string, channel: string) {
        const b = normalizeMessagingAddress(businessNumber);
        const r = normalizeMessagingAddress(recipient);
        return dbState.senderOptOuts.find((o) => o.businessNumber === b && o.recipient === r && o.channel === channel);
      },
      async isOptedOut(businessNumber: string, recipient: string, channel: string) {
        const b = normalizeMessagingAddress(businessNumber);
        const r = normalizeMessagingAddress(recipient);
        return dbState.senderOptOuts.some(
          (o) => o.businessNumber === b && o.recipient === r && o.channel === channel && o.status === 'opted_out',
        );
      },
    },
    // P0: Mock transaction repository for payment state tracking
    // Mirrors packages/database/src/repositories/checkout-sessions.ts.
    checkoutSessionRepository: {
      async create(data: Record<string, unknown>) {
        const row: CheckoutSessionRow = {
          id: randomUUID(),
          token: String(data.token),
          appId: String(data.appId),
          tenantId: String(data.tenantId ?? 'default'),
          amount: String(data.amount),
          currency: String(data.currency),
          status: 'pending',
          successUrl: (data.successUrl as string | null) ?? null,
          cancelUrl: (data.cancelUrl as string | null) ?? null,
          paymentEventId: null,
          metadata: (data.metadata as string | null) ?? null,
          createdAt: new Date(),
          expiresAt: data.expiresAt instanceof Date ? data.expiresAt : new Date(Date.now() + 3_600_000),
        };
        dbState.checkoutSessions.push(row);
        return row as any;
      },
      async findByToken(token: string) {
        return dbState.checkoutSessions.find((c) => c.token === token) as any;
      },
      // UPDATE ... SET status='completed' WHERE token = $1 AND status = 'pending' RETURNING *
      async markCompleted(token: string, paymentEventId: string) {
        const row = dbState.checkoutSessions.find((c) => c.token === token && c.status === 'pending');
        if (!row) return undefined;
        row.status = 'completed';
        row.paymentEventId = paymentEventId;
        return row as any;
      },
      async markExpiredIfPast(token: string) {
        const row = dbState.checkoutSessions.find((c) => c.token === token);
        if (row && row.status === 'pending' && row.expiresAt < new Date()) row.status = 'expired';
      },
    },
    transactionRepository: {
      async findById(id: string) {
        return dbState.transactions.find((t) => t.id === id);
      },
      // Phase 7: optional provider scoping, mirroring the real repository.
      async findByProviderTransactionId(providerTxId: string, providerId?: string) {
        return dbState.transactions.find(
          (t) => t.providerTransactionId === providerTxId && (!providerId || t.providerId === providerId),
        );
      },
      async create(data: Record<string, unknown>) {
        // Mirrors idx_transactions_idempotency (migration 0013): UNIQUE
        // (app_id, tenant_id, idempotency_key); NULL keys never collide.
        if (data.idempotencyKey) {
          const appId = String(data.appId ?? '');
          const tenantId = String(data.tenantId ?? 'default');
          const key = String(data.idempotencyKey);
          if (dbState.transactions.some((t) => t.appId === appId && t.tenantId === tenantId && t.idempotencyKey === key)) {
            throw new UniqueViolationError(
              'idx_transactions_idempotency',
              `Key (app_id, tenant_id, idempotency_key)=(${appId}, ${tenantId}, ${key}) already exists.`,
            );
          }
        }
        const row: TransactionRow = {
          id: `tx_${randomUUID().slice(0, 12)}`,
          appId: String(data.appId ?? ''),
          tenantId: String(data.tenantId ?? 'default'),
          providerId: String(data.providerId ?? ''),
          providerTransactionId: data.providerTransactionId ? String(data.providerTransactionId) : null,
          status: String(data.status ?? 'pending'),
          amount: String(data.amount ?? '0'),
          currency: String(data.currency ?? 'USD'),
          paymentMethod: data.paymentMethod ? String(data.paymentMethod) : null,
          idempotencyKey: data.idempotencyKey ? String(data.idempotencyKey) : null,
          metadata: data.metadata ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.transactions.push(row);
        return row as any;
      },
      // Mirrors the real updateStatus(): the state machine's atomic transition.
      async updateStatus(id: string, status: string) {
        const r = simTransitionStatus(id, status);
        return r.outcome === 'not_found' ? undefined : r.transaction;
      },
      async transitionStatus(id: string, to: string, opts?: Record<string, unknown>) {
        return simTransitionStatus(id, to, opts);
      },
      // Mirrors createPaymentAttemptRepository (repositories/transactions.ts):
      // INSERT ... status 'processing' ON CONFLICT (idx_transactions_idempotency) DO NOTHING.
      async allocatePaymentAttempt(input: Record<string, unknown>) {
        if (dbState.failTransactionWrites) throw new Error('simulated transactions write failure');
        const key = input.idempotencyKey ? String(input.idempotencyKey) : null;
        const appId = String(input.appId ?? '');
        const tenantId = String(input.tenantId ?? 'default');
        if (key && dbState.transactions.some((t) => t.appId === appId && t.tenantId === tenantId && t.idempotencyKey === key)) {
          return undefined;
        }
        const row: TransactionRow = {
          id: randomUUID(),
          appId,
          tenantId,
          providerId: input.providerId ? String(input.providerId) : 'unassigned',
          providerTransactionId: null,
          status: 'processing',
          amount: String(input.amount ?? '0'),
          currency: String(input.currency ?? 'USD'),
          paymentMethod: input.paymentMethod ? String(input.paymentMethod) : null,
          idempotencyKey: key,
          metadata: input.metadata ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.transactions.push(row);
        return row as any;
      },
      // UPDATE ... WHERE id = $1 AND status = 'processing' RETURNING *
      async recordPaymentAttemptOutcome(id: string, outcome: Record<string, any>) {
        const r = simTransitionStatus(id, String(outcome.status), {
          from: ['processing'],
          providerId: outcome.providerId,
          providerTransactionId: outcome.providerTransactionId ?? null,
          amount: outcome.amount,
          currency: outcome.currency,
          metadata: outcome.metadata,
          ...(outcome.reconciliationReason !== undefined ? { reconciliationReason: outcome.reconciliationReason } : {}),
        });
        return r.outcome === 'applied' ? r.transaction : undefined;
      },
      // UPDATE ... SET status='processing' WHERE id = $1 AND status = 'failed'
      //   AND provider_transaction_id IS NULL AND outcome_unknown_at IS NULL
      async reopenFailedPaymentAttempt(id: string) {
        if (dbState.failTransactionWrites) throw new Error('simulated transactions write failure');
        const row = dbState.transactions.find((t) => t.id === id && t.status === 'failed' && !t.providerTransactionId && !t.outcomeUnknownAt);
        if (!row) return undefined;
        row.status = 'processing';
        row.updatedAt = new Date();
        return row as any;
      },
      async findByAppAndIdempotencyKey(appId: string, tenantId: string, key: string) {
        return dbState.transactions.find((t) => t.appId === appId && t.tenantId === tenantId && t.idempotencyKey === key);
      },
      async findByAppId(appId: string, limit = 50) {
        return dbState.transactions.filter((t) => t.appId === appId).slice(0, limit);
      },
      async count() {
        return dbState.transactions.length;
      },
      // Plan payment-volume-limit enforcement — mirrors
      // packages/database/src/repositories/transactions.ts's real
      // implementation (sum only 'success' rows since a given time).
      async sumSuccessfulAmountCentsSince(appId: string, since: Date) {
        return dbState.transactions
          .filter((t) => t.appId === appId && t.status === 'success' && t.createdAt >= since)
          .reduce((sum, t) => sum + Math.round(Number(t.amount) * 100), 0);
      },
      // Phase 6 payment reconciliation — mirrors repositories/transactions.ts
      // (findReconciliationCandidates / markReconciliationChecked /
      // listRequiringReconciliation / countUnresolvedByStatus). Replaces a
      // findStaleUnresolved() double that had no real counterpart.
      async findReconciliationCandidates(q: { staleBefore: Date; recheckBefore: Date; queryableProviderIds: readonly string[]; limit: number }) {
        if (dbState.failTransactionWrites) throw new Error('simulated transactions read failure');
        return dbState.transactions
          .filter((t) => {
            const notRecentlyChecked = !t.reconciliationCheckedAt || t.reconciliationCheckedAt < q.recheckBefore;
            const stuck = ['processing', 'pending', 'requires_action', 'unknown'].includes(t.status) && t.updatedAt < q.staleBefore;
            const escalatedQueryable = t.status === 'requires_reconciliation' && q.queryableProviderIds.includes(t.providerId);
            return notRecentlyChecked && (stuck || escalatedQueryable);
          })
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
          .slice(0, q.limit) as any[];
      },
      async markReconciliationChecked(id: string, lastCheck: Record<string, unknown>) {
        const row = dbState.transactions.find((t) => t.id === id);
        if (!row) return undefined;
        row.reconciliationCheckedAt = new Date();
        row.reconciliationCheckCount = (row.reconciliationCheckCount ?? 0) + 1;
        row.reconciliationLastCheck = lastCheck;
        return row as any;
      },
      async listRequiringReconciliation(q: { limit?: number; appId?: string; includeUnknown?: boolean } = {}) {
        const statuses = q.includeUnknown ? ['requires_reconciliation', 'unknown'] : ['requires_reconciliation'];
        const since = (t: TransactionRow) => (t.reconciliationRequiredAt ?? t.outcomeUnknownAt ?? t.updatedAt).getTime();
        return dbState.transactions
          .filter((t) => statuses.includes(t.status) && (!q.appId || t.appId === q.appId))
          .sort((a, b) => since(a) - since(b))
          .slice(0, Math.min(Math.max(q.limit ?? 100, 1), 500))
          .map((t) => ({
            outcomeUnknownAt: null,
            reconciliationReason: null,
            reconciliationRequiredAt: null,
            reconciliationCheckedAt: null,
            reconciliationCheckCount: 0,
            reconciliationLastCheck: null,
            reconciliationResolvedAt: null,
            reconciliationResolution: null,
            ...t,
          })) as any[];
      },
      async countUnresolvedByStatus() {
        const out: Record<string, number> = {};
        for (const t of dbState.transactions) {
          if ((TX_UNRESOLVED_STATUSES as readonly string[]).includes(t.status)) out[t.status] = (out[t.status] ?? 0) + 1;
        }
        return out;
      },
    },
    // Transactional outbox. The real claim/lease/rescue/dead-letter/replay
    // SQL is exercised against an actual Postgres in packages/database/src/
    // outbox.postgres.integration.test.ts. Here only the operator-facing
    // dead-letter surface (listDead / replayDead / replayDeadBatch /
    // countByStatus / findById — what the gateway's /api/dashboard/outbox
    // routes call) is stateful, over dbState.outboxEvents, so those routes
    // can be driven over HTTP. The consumer side (claimBatch etc.) stays
    // inert: nothing in the simulation dispatches outbox rows, so existing
    // suites keep seeing exactly the bus events they always did.
    outboxEventRepository: (() => {
      const isDead = (r: OutboxEventRow, f: { appId?: string; eventType?: string }) =>
        r.status === 'dead' && (!f.appId || r.appId === f.appId) && (!f.eventType || r.eventType === f.eventType);
      // Mirrors the real single conditional UPDATE ... WHERE status = 'dead'
      // (no await between check and write, so atomic in this process).
      const replay = (r: OutboxEventRow): OutboxEventRow => {
        r.status = 'pending';
        r.attempts = 0;
        r.nextAttemptAt = new Date();
        r.deadAt = null;
        r.replayCount += 1;
        r.updatedAt = new Date();
        return { ...r };
      };
      return {
      async create(data: Record<string, unknown>) {
        const now = new Date();
        const row: OutboxEventRow = {
          id: randomUUID(),
          appId: String(data.appId ?? ''),
          eventType: String(data.eventType ?? ''),
          payload: data.payload ?? {},
          status: (data.status as OutboxEventRow['status']) ?? 'pending',
          createdAt: now,
          processedAt: null,
          error: (data.error as string | undefined) ?? null,
          attempts: Number(data.attempts ?? 0),
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: now,
          deadAt: data.status === 'dead' ? now : null,
          replayCount: 0,
          updatedAt: now,
        };
        dbState.outboxEvents.push(row);
        return { ...row };
      },
      async claimBatch(_limit = 10) {
        return [];
      },
      async renewClaim(_id: string, _claimToken: string) {
        return false;
      },
      async complete(_id: string, _claimToken: string) {
        return false;
      },
      async fail(_id: string, _claimToken: string, _error: string) {
        return null;
      },
      async rescueStale() {
        return { requeued: [], deadLettered: [] };
      },
      async listDead(opts: { appId?: string; eventType?: string; limit?: number } = {}) {
        return dbState.outboxEvents
          .filter((r) => isDead(r, opts))
          .sort((a, b) => (b.deadAt?.getTime() ?? 0) - (a.deadAt?.getTime() ?? 0))
          .slice(0, Math.min(Math.max(1, opts.limit ?? 50), 500))
          .map((r) => ({ ...r }));
      },
      async replayDead(id: string) {
        const r = dbState.outboxEvents.find((x) => x.id === id && x.status === 'dead');
        return r ? replay(r) : undefined;
      },
      async replayDeadBatch(opts: { appId?: string; eventType?: string; limit?: number } = {}) {
        return dbState.outboxEvents
          .filter((r) => isDead(r, opts))
          .slice(0, Math.min(Math.max(1, opts.limit ?? 100), 1000))
          .map(replay);
      },
      async countByStatus() {
        const out: Record<string, number> = { pending: 0, processing: 0, completed: 0, dead: 0 };
        for (const r of dbState.outboxEvents) out[r.status] = (out[r.status] ?? 0) + 1;
        return out;
      },
      async findById(id: string) {
        const r = dbState.outboxEvents.find((x) => x.id === id);
        return r ? { ...r } : undefined;
      },
      async findPending() {
        return dbState.outboxEvents.filter((r) => r.status === 'pending').map((r) => ({ ...r }));
      },
      async count() {
        return dbState.outboxEvents.length;
      },
      };
    })(),
    // Phase 4: in-memory double of packages/database/src/repositories/
    // webhook-events.ts. Each method's check-and-write runs with no `await`
    // in between, so — like the real single-statement SQL — it is atomic with
    // respect to concurrent requests in this single-threaded process. The
    // uniqueness of (providerId, providerEventId) mirrors the real
    // uq_webhook_events_provider_event index; the real SQL (and the real
    // index) is exercised against an actual Postgres in
    // packages/database/src/webhook-events.postgres.integration.test.ts.
    webhookEventRepository: (() => {
      const guard = () => {
        if (dbState.failWebhookEventStore) {
          throw new Error('simulated database outage (webhook_events)');
        }
      };
      const copy = <T extends object>(r: T | undefined): T | undefined => (r ? ({ ...r } as T) : undefined);
      const leaseFree = (r: WebhookEventRow, now: number) =>
        r.enqueueLeaseUntil === null || r.enqueueLeaseUntil.getTime() <= now;
      const refreshProcessed = (eventId: string) => {
        const ev = dbState.webhookEvents.find((e) => e.id === eventId);
        if (!ev || ev.status === 'processed') return;
        const allDone = ev.expectedConsumers.every((c) =>
          dbState.webhookEventConsumers.some((wc) => wc.webhookEventId === eventId && wc.consumer === c && wc.status === 'processed'),
        );
        if (allDone) {
          ev.status = 'processed';
          ev.processedAt = new Date();
          ev.lastError = null;
          ev.updatedAt = new Date();
        }
      };
      const repo = {
        async claim(input: {
          providerId: string;
          providerEventId: string;
          appId?: string | null;
          tenantId?: string | null;
          eventType?: string | null;
          payload: unknown;
          rawBody: string;
          signature?: string | null;
          expectedConsumers: string[];
          enqueueLeaseMs: number;
        }) {
          guard();
          if (!input.providerId || !input.providerEventId) {
            throw new Error('violates check constraint "chk_webhook_events_provider_event_id_nonempty"');
          }
          const existing = dbState.webhookEvents.find(
            (e) => e.providerId === input.providerId && e.providerEventId === input.providerEventId,
          );
          if (existing) return { claimed: false as const, existing: copy(existing) };
          const now = new Date();
          const row: WebhookEventRow = {
            id: randomUUID(),
            providerId: input.providerId,
            providerEventId: input.providerEventId,
            appId: input.appId ?? null,
            tenantId: input.tenantId ?? null,
            eventType: input.eventType ?? null,
            payload: input.payload ?? {},
            rawBody: input.rawBody,
            signature: input.signature ?? null,
            status: 'received',
            expectedConsumers: [...input.expectedConsumers],
            attempts: 0,
            lastError: null,
            enqueuedJobs: [],
            enqueuedAt: null,
            enqueueLeaseUntil: new Date(now.getTime() + Math.max(0, input.enqueueLeaseMs)),
            receivedAt: now,
            processedAt: null,
            updatedAt: now,
          };
          dbState.webhookEvents.push(row);
          return { claimed: true as const, event: copy(row)! };
        },
        async findById(id: string) {
          guard();
          return copy(dbState.webhookEvents.find((e) => e.id === id));
        },
        async findByProviderEvent(providerId: string, providerEventId: string) {
          guard();
          return copy(dbState.webhookEvents.find((e) => e.providerId === providerId && e.providerEventId === providerEventId));
        },
        async acquireEnqueueLease(id: string, leaseMs: number) {
          guard();
          const now = Date.now();
          const row = dbState.webhookEvents.find((e) => e.id === id);
          if (!row || row.enqueuedAt !== null || !leaseFree(row, now)) return undefined;
          row.enqueueLeaseUntil = new Date(now + Math.max(0, leaseMs));
          row.updatedAt = new Date(now);
          return copy(row);
        },
        async markEnqueued(id: string, jobs: string[]) {
          guard();
          const row = dbState.webhookEvents.find((e) => e.id === id);
          if (!row) return false;
          row.enqueuedAt = new Date();
          row.enqueuedJobs = [...jobs];
          row.enqueueLeaseUntil = null;
          row.updatedAt = new Date();
          return true;
        },
        async releaseEnqueueLease(id: string, jobs: string[], error: string) {
          guard();
          const row = dbState.webhookEvents.find((e) => e.id === id);
          if (!row) return;
          row.enqueueLeaseUntil = null;
          row.enqueuedJobs = [...jobs];
          row.lastError = error;
          row.updatedAt = new Date();
        },
        async claimStrandedForEnqueue(opts: { limit: number; leaseMs: number; staleAfterMs: number; consumers: string[] }) {
          guard();
          const now = Date.now();
          const rows = dbState.webhookEvents
            .filter(
              (r) =>
                r.expectedConsumers.some((c) => opts.consumers.includes(c)) &&
                leaseFree(r, now) &&
                (r.enqueuedAt === null || (r.status === 'received' && r.enqueuedAt.getTime() <= now - opts.staleAfterMs)),
            )
            .sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime())
            .slice(0, opts.limit);
          for (const r of rows) {
            r.enqueueLeaseUntil = new Date(now + Math.max(0, opts.leaseMs));
            r.updatedAt = new Date(now);
          }
          return rows.map((r) => copy(r)!);
        },
        async claimConsumer(webhookEventId: string, consumer: string, leaseMs: number) {
          guard();
          const now = Date.now();
          const existing = dbState.webhookEventConsumers.find(
            (c) => c.webhookEventId === webhookEventId && c.consumer === consumer,
          );
          const lease = new Date(now + Math.max(0, leaseMs));
          let claimed: WebhookEventConsumerRow | undefined;
          if (!existing) {
            claimed = {
              webhookEventId,
              consumer,
              status: 'processing',
              attempts: 1,
              claimToken: randomUUID(),
              leaseExpiresAt: lease,
              lastError: null,
              startedAt: new Date(now),
              processedAt: null,
              updatedAt: new Date(now),
            };
            dbState.webhookEventConsumers.push(claimed);
          } else if (
            existing.status === 'failed' ||
            (existing.status === 'processing' && existing.leaseExpiresAt !== null && existing.leaseExpiresAt.getTime() <= now)
          ) {
            existing.status = 'processing';
            existing.attempts += 1;
            existing.claimToken = randomUUID();
            existing.leaseExpiresAt = lease;
            existing.lastError = null;
            existing.updatedAt = new Date(now);
            claimed = existing;
          }
          if (!claimed) return { claimed: false as const, existing: copy(existing) };
          const ev = dbState.webhookEvents.find((e) => e.id === webhookEventId);
          if (ev && ev.status !== 'processed') {
            ev.status = 'processing';
            ev.attempts += 1;
            ev.updatedAt = new Date(now);
          }
          return { claimed: true as const, consumer: copy(claimed)! };
        },
        async findConsumer(webhookEventId: string, consumer: string) {
          guard();
          return copy(dbState.webhookEventConsumers.find((c) => c.webhookEventId === webhookEventId && c.consumer === consumer));
        },
        async findConsumers(webhookEventId: string) {
          guard();
          return dbState.webhookEventConsumers.filter((c) => c.webhookEventId === webhookEventId).map((c) => copy(c)!);
        },
        async completeConsumer(webhookEventId: string, consumer: string, claimToken: string) {
          guard();
          const row = dbState.webhookEventConsumers.find(
            (c) => c.webhookEventId === webhookEventId && c.consumer === consumer && c.claimToken === claimToken && c.status === 'processing',
          );
          if (!row) return false;
          row.status = 'processed';
          row.processedAt = new Date();
          row.leaseExpiresAt = null;
          row.lastError = null;
          row.updatedAt = new Date();
          refreshProcessed(webhookEventId);
          return true;
        },
        async failConsumer(webhookEventId: string, consumer: string, claimToken: string, error: string) {
          guard();
          const row = dbState.webhookEventConsumers.find(
            (c) => c.webhookEventId === webhookEventId && c.consumer === consumer && c.claimToken === claimToken && c.status === 'processing',
          );
          if (!row) return false;
          row.status = 'failed';
          row.leaseExpiresAt = null;
          row.lastError = error;
          row.updatedAt = new Date();
          const ev = dbState.webhookEvents.find((e) => e.id === webhookEventId);
          if (ev && ev.status !== 'processed') {
            ev.status = 'failed';
            ev.lastError = `${consumer}: ${error}`;
            ev.updatedAt = new Date();
          }
          return true;
        },
        // Mirrors the real single-statement CTE: events (+ optional outbox)
        // row written together, at most once per idempotencyKey. Honours the
        // same failEventWrites fault toggle as eventRepository.create, since
        // in production this is the webhook consumers' events write.
        // Phase 5: also mirrors the optional transactions status transition
        // (upd_tx CTE), applied in the same no-await step and only when the
        // events row is actually inserted.
        async persistEffectsOnce(input: {
          idempotencyKey: string;
          event: Record<string, unknown>;
          outbox?: { appId: string; eventType: string; payload: unknown };
          transactionStatus?: { providerTransactionId: string; toStatus: string; allowedFrom: readonly string[]; paymentTransactionId?: string | null };
        }) {
          if (dbState.failEventWrites) {
            throw new Error('database unavailable (simulated): connection refused');
          }
          const prior = dbState.events.find((e) => e.idempotencyKey === input.idempotencyKey);
          if (prior) return { inserted: false, eventId: prior.id, transactionUpdated: false };
          const row = normalizeRow({ ...input.event, idempotencyKey: input.idempotencyKey });
          dbState.events.push(row);
          let transactionUpdated = false;
          const ts = input.transactionStatus;
          if (ts) {
            // Phase 6: provider id first, then the platform's own row id
            // (only for a row with no provider id yet, same provider or never
            // assigned one) — mirrors the real target_tx CTE.
            const providerId = String(input.event.providerId ?? '');
            const tx =
              dbState.transactions.find((t) => t.providerTransactionId === ts.providerTransactionId) ??
              (ts.paymentTransactionId
                ? dbState.transactions.find(
                    (t) => t.id === ts.paymentTransactionId && !t.providerTransactionId && (t.providerId === providerId || t.providerId === 'unassigned'),
                  )
                : undefined);
            if (tx && ts.allowedFrom.includes(tx.status)) {
              const wasAmbiguous = (TX_AMBIGUOUS_STATUSES as readonly string[]).includes(tx.status);
              const toAmbiguous = (TX_AMBIGUOUS_STATUSES as readonly string[]).includes(ts.toStatus);
              tx.providerTransactionId = tx.providerTransactionId ?? ts.providerTransactionId;
              if (toAmbiguous) tx.outcomeUnknownAt = tx.outcomeUnknownAt ?? new Date();
              else if (wasAmbiguous) {
                tx.reconciliationResolvedAt = new Date();
                tx.reconciliationResolution = { source: 'provider_webhook', webhookIdempotencyKey: input.idempotencyKey, providerTransactionId: ts.providerTransactionId };
              }
              tx.status = ts.toStatus;
              tx.updatedAt = new Date();
              transactionUpdated = true;
            }
          }
          return { inserted: true, eventId: row.id, transactionUpdated };
        },
        async count() {
          return dbState.webhookEvents.length;
        },
      };
      return repo;
    })(),
    // Idempotency record repository — a faithful in-memory model of
    // packages/database/src/repositories/idempotency-records.ts (it used to be
    // a no-op whose findActive() always returned undefined, which meant no
    // simulation test ever exercised payment idempotency at all).
    //
    // claim() models the single INSERT ... ON CONFLICT (app_id, tenant_id,
    // operation, idempotency_key) DO UPDATE ... WHERE <expired OR failed with
    // same/legacy hash> RETURNING * statement. Its check-and-write runs with
    // no `await` in between, so — like the real statement — it is atomic with
    // respect to concurrent requests in this single-threaded process. The
    // real SQL is exercised against an actual Postgres in
    // packages/database/src/idempotency.postgres.integration.test.ts.
    idempotencyRecordRepository: (() => {
      const guard = () => {
        if (dbState.failIdempotencyStore) {
          throw new Error('simulated database outage (idempotency_records)');
        }
      };
      const findRow = (appId: string, tenantId: string, operation: string, key: string) =>
        dbState.idempotencyRecords.find(
          (r) => r.appId === appId && r.tenantId === tenantId && r.operation === operation && r.idempotencyKey === key,
        );
      return {
        async findActive(appId: string, tenantId: string, operation: string, key: string) {
          guard();
          const row = findRow(appId, tenantId, operation, key);
          return row && row.expiresAt.getTime() > Date.now() ? { ...row } : undefined;
        },
        async findByKey(appId: string, tenantId: string, operation: string, key: string) {
          guard();
          const row = findRow(appId, tenantId, operation, key);
          return row ? { ...row } : undefined;
        },
        async claim(input: {
          appId: string;
          tenantId: string;
          operation: string;
          idempotencyKey: string;
          requestHash: string;
          ttlMs: number;
        }) {
          guard();
          const now = Date.now();
          const expiresAt = new Date(now + Math.max(0, input.ttlMs));
          const existing = findRow(input.appId, input.tenantId, input.operation, input.idempotencyKey);
          if (!existing) {
            const row: IdempotencyRecordRow = {
              id: `idem_${randomUUID()}`,
              appId: input.appId,
              tenantId: input.tenantId,
              operation: input.operation,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              status: 'processing',
              result: null,
              createdAt: new Date(now),
              expiresAt,
            };
            dbState.idempotencyRecords.push(row);
            return { claimed: true as const, record: { ...row } };
          }
          const reclaimable =
            existing.expiresAt.getTime() <= now ||
            (existing.status === 'failed' && (existing.requestHash === '' || existing.requestHash === input.requestHash));
          if (reclaimable) {
            existing.id = `idem_${randomUUID()}`; // fencing token rotates, like gen_random_uuid()
            existing.status = 'processing';
            existing.requestHash = input.requestHash;
            existing.result = null;
            existing.createdAt = new Date(now);
            existing.expiresAt = expiresAt;
            return { claimed: true as const, record: { ...existing } };
          }
          return { claimed: false as const, existing: { ...existing } };
        },
        async complete(id: string, result: unknown) {
          guard();
          const row = dbState.idempotencyRecords.find((r) => r.id === id && r.status === 'processing');
          if (!row) return false;
          row.status = 'completed';
          row.result = result;
          return true;
        },
        async fail(id: string, error: string) {
          guard();
          const row = dbState.idempotencyRecords.find((r) => r.id === id && r.status === 'processing');
          if (!row) return false;
          row.status = 'failed';
          row.result = { error };
          return true;
        },
        async create(data: Record<string, unknown>) {
          guard();
          const key = [data.appId, data.tenantId ?? 'default', data.operation, data.idempotencyKey] as string[];
          if (findRow(key[0], key[1], key[2], key[3])) {
            throw new UniqueViolationError('idx_idempotency_composite', `Key (app_id, tenant_id, operation, idempotency_key)=(${key.join(', ')}) already exists.`);
          }
          const row: IdempotencyRecordRow = {
            id: `idem_${randomUUID()}`,
            appId: key[0],
            tenantId: key[1],
            operation: key[2],
            idempotencyKey: key[3],
            requestHash: String(data.requestHash ?? ''),
            status: String(data.status ?? 'pending'),
            result: data.result ?? null,
            createdAt: new Date(),
            expiresAt: data.expiresAt as Date,
          };
          dbState.idempotencyRecords.push(row);
          return { ...row } as any;
        },
        async count() {
          return dbState.idempotencyRecords.length;
        },
      };
    })(),
    // Real (not stubbed) in-memory supplier repository — mirrors
    // packages/database/src/repositories/suppliers.ts, including its unique
    // (application_id, tenant_id, slug) index. Phase 7: it used to return
    // `undefined` for every lookup, so supplier isolation could never be
    // exercised by any simulation test (gap register F14 item 6).
    supplierRepository: {
      async findById(id: string) {
        return dbState.suppliers.find((s) => s.id === id);
      },
      async findByApplicationAndSlug(applicationId: string, tenantId: string, slug: string) {
        return dbState.suppliers.find((s) => s.applicationId === applicationId && s.tenantId === tenantId && s.slug === slug);
      },
      async findByApplicationAndTenant(applicationId: string, tenantId: string) {
        return dbState.suppliers
          .filter((s) => s.applicationId === applicationId && s.tenantId === tenantId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async create(data: Record<string, unknown>) {
        const applicationId = String(data.applicationId);
        const tenantId = String(data.tenantId);
        const slug = String(data.slug);
        if (dbState.suppliers.some((s) => s.applicationId === applicationId && s.tenantId === tenantId && s.slug === slug)) {
          throw new UniqueViolationError(
            'idx_suppliers_application_slug',
            `Key (application_id, tenant_id, slug)=(${applicationId}, ${tenantId}, ${slug}) already exists.`,
          );
        }
        const row: SupplierRow = {
          id: randomUUID(),
          applicationId,
          tenantId,
          name: String(data.name),
          slug,
          type: String(data.type),
          status: data.status ? String(data.status) : 'active',
          metadata: data.metadata ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.suppliers.push(row);
        return row;
      },
      async update(id: string, data: Record<string, unknown>) {
        const row = dbState.suppliers.find((s) => s.id === id);
        if (!row) return undefined;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      async findByApplicationId(applicationId: string) {
        return dbState.suppliers.filter((s) => s.applicationId === applicationId);
      },
      async count() {
        return dbState.suppliers.length;
      },
    },
    // Real (not stubbed) in-memory mock — backs consent enforcement in the
    // routing layer, so simulation tests can actually exercise STOP
    // blocking a subsequent send, not just that the keyword was logged.
    consentRecordRepository: {
      async findByRecipient(appId: string, tenantId: string, recipient: string, channel: string) {
        return dbState.consentRecords.find(
          (c) => c.appId === appId && c.tenantId === tenantId && c.recipient === recipient && c.channel === channel,
        );
      },
      async upsert(data: {
        appId: string;
        tenantId: string;
        recipient: string;
        channel: string;
        status: 'opted_in' | 'opted_out' | 'unknown';
        source: 'keyword' | 'api' | 'import';
        keyword?: string | null;
      }) {
        const existing = dbState.consentRecords.find(
          (c) => c.appId === data.appId && c.tenantId === data.tenantId && c.recipient === data.recipient && c.channel === data.channel,
        );
        if (existing) {
          existing.status = data.status;
          existing.source = data.source;
          existing.keyword = data.keyword ?? null;
          existing.updatedAt = new Date();
          return existing;
        }
        const row: ConsentRow = {
          id: `consent_${randomUUID().slice(0, 12)}`,
          appId: data.appId,
          tenantId: data.tenantId,
          recipient: data.recipient,
          channel: data.channel,
          status: data.status,
          source: data.source,
          keyword: data.keyword ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.consentRecords.push(row);
        return row;
      },
      async isOptedOut(appId: string, tenantId: string, recipient: string, channel: string) {
        const record = dbState.consentRecords.find(
          (c) => c.appId === appId && c.tenantId === tenantId && c.recipient === recipient && c.channel === channel,
        );
        return record?.status === 'opted_out';
      },
      async findByApplicationId(appId: string, limit = 100) {
        return dbState.consentRecords.filter((c) => c.appId === appId).slice(0, limit);
      },
      async count() {
        return dbState.consentRecords.length;
      },
    },
    messagingProfileRepository: {
      async findById(id: string) {
        return dbState.messagingProfiles.find((p) => p.id === id);
      },
      async findBySender(appId: string, tenantId: string, sender: string, provider: string) {
        const normalized = normalizeMessagingAddress(sender);
        return dbState.messagingProfiles.find(
          (p) => p.appId === appId && p.tenantId === tenantId && p.sender === normalized && p.provider === provider,
        );
      },
      // Phase 8: provider → destination number → owners (deterministic order).
      async findOwnersOfSender(sender: string, provider: string) {
        const normalized = normalizeMessagingAddress(sender);
        if (!normalized) return [];
        return dbState.messagingProfiles
          .filter((p) => p.sender === normalized && p.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));
      },
      async findSendersForOwner(appId: string, tenantId: string, provider: string) {
        return dbState.messagingProfiles
          .filter((p) => p.appId === appId && p.tenantId === tenantId && p.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));
      },
      // Phase 7 (F3.2): tenant-scoped, mirroring the real repository.
      async findByAppAndTenant(appId: string, tenantId: string, limit = 100) {
        return dbState.messagingProfiles.filter((p) => p.appId === appId && p.tenantId === tenantId).slice(0, limit);
      },
      async create(data: {
        appId: string;
        tenantId: string;
        country: string;
        senderType: string;
        sender: string;
        provider: string;
        campaignId?: string | null;
        brandId?: string | null;
        complianceStatus?: string;
        supplierId?: string | null;
      }) {
        // Mirrors the validation in packages/database/src/repositories/messaging-profiles.ts
        // (kept duplicated rather than imported since this mock stands in
        // for the whole @company/database module).
        if (!MESSAGING_PROFILE_SENDER_TYPES.has(data.senderType)) {
          throw new Error(`Invalid senderType: ${data.senderType}`);
        }
        const complianceStatus = data.complianceStatus ?? 'unregistered';
        if (!MESSAGING_PROFILE_COMPLIANCE_STATUSES.has(complianceStatus)) {
          throw new Error(`Invalid complianceStatus: ${complianceStatus}`);
        }
        const row: MessagingProfileRow = {
          id: `mprof_${randomUUID().slice(0, 12)}`,
          appId: data.appId,
          tenantId: data.tenantId,
          country: data.country,
          senderType: data.senderType,
          sender: normalizeMessagingAddress(data.sender),
          provider: data.provider,
          supplierId: data.supplierId ?? null,
          campaignId: data.campaignId ?? null,
          brandId: data.brandId ?? null,
          complianceStatus,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.messagingProfiles.push(row);
        return row;
      },
      async updateComplianceStatus(id: string, status: string) {
        if (!MESSAGING_PROFILE_COMPLIANCE_STATUSES.has(status)) {
          throw new Error(`Invalid complianceStatus: ${status}`);
        }
        const profile = dbState.messagingProfiles.find((p) => p.id === id);
        if (!profile) return undefined;
        profile.complianceStatus = status;
        profile.updatedAt = new Date();
        return profile;
      },
      async count() {
        return dbState.messagingProfiles.length;
      },
    },
    // P0: Mock runInTransaction — just runs the function directly in simulation
    runInTransaction: async (fn: (tx: any) => Promise<any>) => {
      return fn(null);
    },
    ApplicationRegistry: class {
      async createApplication(input: { name: string; slug: string; environment?: string }) {
        if (dbState.applications.some((a) => a.name === input.name)) {
          throw new Error(`Application with name "${input.name}" already exists`);
        }
        if (dbState.applications.some((a) => a.slug === input.slug)) {
          throw new Error(`Application with slug "${input.slug}" already exists`);
        }
        const application = {
          id: `app_${randomUUID().slice(0, 8)}`,
          slug: input.slug,
          name: input.name,
          status: 'active',
          environment: input.environment ?? 'development',
        };
        dbState.applications.push(application);

        const { raw, hash, prefix } = generateApiKey();
        const apiKeyRow = {
          id: `key_${randomUUID().slice(0, 8)}`,
          keyHash: hash,
          applicationId: application.id,
          environment: application.environment,
          revokedAt: null,
          expiresAt: null,
        };
        dbState.apiKeys.push(apiKeyRow);

        return {
          application,
          apiKey: { id: apiKeyRow.id, raw, hash, prefix, environment: apiKeyRow.environment },
        };
      }
      async authenticateApplication(rawKey: string, _environment?: string) {
        if (!rawKey || rawKey.length === 0) {
          return { authenticated: false, error: 'API key is required' };
        }
        const key = dbState.apiKeys.find((k) => k.keyHash === sha256(rawKey));
        if (!key) return { authenticated: false, error: 'Invalid API key' };
        if (key.revokedAt) return { authenticated: false, error: 'API key has been revoked' };
        if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
          return { authenticated: false, error: 'API key has expired' };
        }
        const application = dbState.applications.find((a) => a.id === key.applicationId);
        if (!application) return { authenticated: false, error: 'Application not found for this API key' };
        if (application.status !== 'active') {
          return { authenticated: false, error: `Application is in "${application.status}" status` };
        }
        return { authenticated: true, application };
      }
    },
    TenantRegistry: class {
      async assertTenantAccess(applicationId: string, tenantId: string): Promise<void> {
        const linked = dbState.tenantLinks.some((l) => l.tenantId === tenantId && l.applicationId === applicationId);
        if (!linked) {
          throw new Error(`Access denied: tenant ${tenantId} is not linked to application ${applicationId}`);
        }
      }
      async resolveTenant(applicationId: string, tenantSlug: string) {
        const tenant = dbState.tenants.find((t) => t.slug === tenantSlug);
        if (!tenant) return { resolved: false, error: `Tenant "${tenantSlug}" not found` };
        if (tenant.status !== 'active') return { resolved: false, error: `Tenant "${tenantSlug}" is in "${tenant.status}" status` };
        const linked = dbState.tenantLinks.some((l) => l.tenantId === tenant.id && l.applicationId === applicationId);
        if (!linked) return { resolved: false, error: `Tenant "${tenantSlug}" is not linked to this application` };
        return { resolved: true, tenant, applicationId };
      }
    },
    AuthError: MockAuthError,
    ValidationError: MockValidationError,
    ConflictError: MockConflictError,
    SubscriptionError: MockSubscriptionError,
    CrmError: MockCrmError,
    SubscriptionRegistry: class {
      async listPlans() {
        return dbState.plans.filter((p) => p.isActive);
      }

      async getSubscription(applicationId: string) {
        return dbState.subscriptions.find((s) => s.applicationId === applicationId);
      }

      // Simulated-only in the simulation harness — no live Stripe key is
      // ever configured here, matching every other adapter's fallback path.
      async subscribe(applicationId: string, planSlug: string, _customerEmail: string) {
        const application = dbState.applications.find((a) => a.id === applicationId);
        if (!application) throw new MockSubscriptionError(`Application ${applicationId} not found`);

        const plan = dbState.plans.find((p) => p.slug === planSlug);
        if (!plan || !plan.isActive) throw new MockSubscriptionError(`Plan "${planSlug}" not found or inactive`);

        const existing = dbState.subscriptions.find((s) => s.applicationId === applicationId);
        const now = new Date();
        const periodMs = INTERVAL_MS[plan.interval] ?? INTERVAL_MS.month;
        const data = {
          planId: plan.id,
          status: 'active',
          stripeCustomerId: existing?.stripeCustomerId ?? 'sim_cus_' + randomUUID().replace(/-/g, '').slice(0, 16),
          stripeSubscriptionId: 'sim_sub_' + randomUUID().replace(/-/g, '').slice(0, 16),
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + periodMs),
          cancelAtPeriodEnd: false,
          canceledAt: null,
        };
        if (existing) {
          Object.assign(existing, data, { updatedAt: new Date() });
          return existing;
        }
        const row: SubscriptionRow = {
          id: `subx_${randomUUID().slice(0, 8)}`,
          applicationId,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        dbState.subscriptions.push(row);
        return row;
      }

      async cancelSubscription(applicationId: string, atPeriodEnd: boolean) {
        const existing = dbState.subscriptions.find((s) => s.applicationId === applicationId);
        if (!existing) throw new MockSubscriptionError(`No subscription found for application ${applicationId}`);
        if (atPeriodEnd) {
          existing.cancelAtPeriodEnd = true;
        } else {
          existing.status = 'canceled';
          existing.canceledAt = new Date();
          existing.cancelAtPeriodEnd = false;
        }
        existing.updatedAt = new Date();
        return existing;
      }

      async syncFromStripeEvent(event: { type: string; data: { object: Record<string, unknown> } }) {
        const obj = event.data.object as any;
        if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
          const existing = dbState.subscriptions.find((s) => s.stripeSubscriptionId === obj.id);
          if (!existing) return null;
          existing.status = event.type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
          existing.cancelAtPeriodEnd = !!obj.cancel_at_period_end;
          existing.updatedAt = new Date();
          return existing;
        }
        if (event.type === 'invoice.payment_failed') {
          const existing = dbState.subscriptions.find((s) => s.stripeSubscriptionId === obj.subscription);
          if (!existing) return null;
          existing.status = 'past_due';
          existing.updatedAt = new Date();
          return existing;
        }
        return null;
      }
    },
    CrmRegistry: class {
      private toUserSummary(user: UserRow) {
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          lastLoginAt: user.lastLoginAt,
          emailVerifiedAt: user.emailVerifiedAt,
        };
      }

      private async summarize(application: { id: string; name: string; slug: string; status: string; environment: string; createdAt?: Date }) {
        const subscription = dbState.subscriptions.find((s) => s.applicationId === application.id);
        const users = dbState.users.filter((u) => u.applicationId === application.id);
        const openTicketCount = dbState.supportTickets.filter(
          (t) => t.applicationId === application.id && t.status === 'open',
        ).length;
        const plan = subscription ? dbState.plans.find((p) => p.id === subscription.planId) : undefined;
        return {
          application: { ...application, createdAt: application.createdAt ?? new Date() },
          subscription: subscription ?? null,
          plan: plan ? { id: plan.id, slug: plan.slug, name: plan.name } : null,
          userCount: users.length,
          openTicketCount,
        };
      }

      async listCustomers() {
        return Promise.all(dbState.applications.map((a) => this.summarize(a as any)));
      }

      async getCustomer(applicationId: string) {
        const application = dbState.applications.find((a) => a.id === applicationId);
        if (!application) return null;
        const summary = await this.summarize(application as any);
        const users = dbState.users.filter((u) => u.applicationId === applicationId).map((u) => this.toUserSummary(u));
        const notes = dbState.customerNotes.filter((n) => n.applicationId === applicationId);
        const tickets = dbState.supportTickets.filter((t) => t.applicationId === applicationId);
        return { ...summary, users, notes, tickets };
      }

      async addNote(applicationId: string, authorName: string, body: string) {
        if (!body || !body.trim()) throw new MockCrmError('Note body is required');
        const application = dbState.applications.find((a) => a.id === applicationId);
        if (!application) throw new MockCrmError(`Application ${applicationId} not found`);
        const row: CustomerNoteRow = {
          id: `note_${randomUUID().slice(0, 8)}`,
          applicationId,
          authorName: authorName || 'Admin',
          body,
          createdAt: new Date(),
        };
        dbState.customerNotes.push(row);
        return row;
      }

      async listTickets(status?: string) {
        if (status && !TICKET_STATUSES.includes(status)) throw new MockCrmError(`Invalid status "${status}"`);
        return status ? dbState.supportTickets.filter((t) => t.status === status) : dbState.supportTickets;
      }

      async getTicket(ticketId: string) {
        const ticket = dbState.supportTickets.find((t) => t.id === ticketId);
        if (!ticket) return null;
        const comments = dbState.ticketComments.filter((c) => c.ticketId === ticketId);
        return { ticket, comments };
      }

      async createTicket(
        applicationId: string,
        input: { subject: string; description: string; priority?: string; requesterEmail?: string },
      ) {
        if (!input.subject || !input.subject.trim()) throw new MockCrmError('subject is required');
        if (!input.description || !input.description.trim()) throw new MockCrmError('description is required');
        const priority = input.priority ?? 'normal';
        if (!TICKET_PRIORITIES.includes(priority)) throw new MockCrmError(`Invalid priority "${priority}"`);
        const application = dbState.applications.find((a) => a.id === applicationId);
        if (!application) throw new MockCrmError(`Application ${applicationId} not found`);

        const row: SupportTicketRow = {
          id: `ticket_${randomUUID().slice(0, 8)}`,
          applicationId,
          subject: input.subject,
          description: input.description,
          status: 'open',
          priority,
          requesterEmail: input.requesterEmail ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          resolvedAt: null,
        };
        dbState.supportTickets.push(row);
        return row;
      }

      async updateTicket(ticketId: string, updates: { status?: string; priority?: string }) {
        if (updates.status && !TICKET_STATUSES.includes(updates.status)) {
          throw new MockCrmError(`Invalid status "${updates.status}"`);
        }
        if (updates.priority && !TICKET_PRIORITIES.includes(updates.priority)) {
          throw new MockCrmError(`Invalid priority "${updates.priority}"`);
        }
        const existing = dbState.supportTickets.find((t) => t.id === ticketId);
        if (!existing) throw new MockCrmError(`Ticket ${ticketId} not found`);

        Object.assign(existing, updates, { updatedAt: new Date() });
        if (updates.status === 'resolved' || updates.status === 'closed') {
          existing.resolvedAt = new Date();
        }
        return existing;
      }

      async addTicketComment(ticketId: string, authorName: string, body: string) {
        if (!body || !body.trim()) throw new MockCrmError('Comment body is required');
        const ticket = dbState.supportTickets.find((t) => t.id === ticketId);
        if (!ticket) throw new MockCrmError(`Ticket ${ticketId} not found`);
        const row: TicketCommentRow = {
          id: `comment_${randomUUID().slice(0, 8)}`,
          ticketId,
          authorName: authorName || 'Admin',
          body,
          createdAt: new Date(),
        };
        dbState.ticketComments.push(row);
        return row;
      }
    },
    // Faithful-enough reimplementation of packages/database/src/auth-registry.ts
    // against dbState, for the same reason every other class here is
    // reimplemented rather than imported — see the module-level comment.
    AuthRegistry: class {
      private toPublic(user: UserRow) {
        const { passwordHash: _passwordHash, ...rest } = user;
        return rest;
      }

      async signup(input: {
        email: string;
        password: string;
        name?: string;
        applicationName: string;
        applicationSlug: string;
      }) {
        if (!input.email || !input.email.includes('@')) {
          throw new MockValidationError('A valid email is required');
        }
        if (!input.password || input.password.length < 8) {
          throw new MockValidationError('Password must be at least 8 characters');
        }
        if (!input.applicationName || !input.applicationSlug) {
          throw new MockValidationError('applicationName and applicationSlug are required');
        }
        if (dbState.users.some((u) => u.email === input.email)) {
          throw new MockConflictError('An account with this email already exists');
        }
        if (dbState.applications.some((a) => a.name === input.applicationName)) {
          throw new Error(`Application with name "${input.applicationName}" already exists`);
        }
        if (dbState.applications.some((a) => a.slug === input.applicationSlug)) {
          throw new Error(`Application with slug "${input.applicationSlug}" already exists`);
        }

        const application = {
          id: `app_${randomUUID().slice(0, 8)}`,
          slug: input.applicationSlug,
          name: input.applicationName,
          status: 'active',
          environment: 'development',
        };
        dbState.applications.push(application);

        const { raw: rawKey, hash: keyHash, prefix } = generateApiKey();
        dbState.apiKeys.push({
          id: `key_${randomUUID().slice(0, 8)}`,
          keyHash,
          applicationId: application.id,
          environment: application.environment,
          revokedAt: null,
          expiresAt: null,
        });

        let role = dbState.roles.find((r) => r.applicationId === application.id && r.name === 'Owner');
        if (!role) {
          role = {
            id: `role_${randomUUID().slice(0, 8)}`,
            applicationId: application.id,
            name: 'Owner',
            description: "Full access — created automatically for the application's first user",
            isSystem: 'true',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbState.roles.push(role);
        }

        const user: UserRow = {
          id: `user_${randomUUID().slice(0, 8)}`,
          applicationId: application.id,
          tenantId: null,
          roleId: role.id,
          email: input.email,
          name: input.name ?? null,
          passwordHash: hashPassword(input.password),
          emailVerifiedAt: null,
          lastLoginAt: null,
          failedLoginAttempts: 0,
          lockedUntilAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.users.push(user);

        const verification = generateVerificationToken();
        dbState.userVerificationTokens.push({
          id: `uvt_${randomUUID().slice(0, 8)}`,
          userId: user.id,
          purpose: 'email_verification',
          tokenHash: verification.hash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          usedAt: null,
          createdAt: new Date(),
        });

        return {
          user: this.toPublic(user),
          application,
          apiKey: { raw: rawKey, prefix, environment: application.environment },
          emailVerificationToken: verification.raw,
        };
      }

      async login(input: { email: string; password: string; userAgent?: string; ipAddress?: string }) {
        const user = dbState.users.find((u) => u.email === input.email);
        if (!user || !user.passwordHash) {
          throw new MockAuthError('Invalid email or password');
        }
        if (user.lockedUntilAt && new Date(user.lockedUntilAt) > new Date()) {
          throw new MockAuthError(
            `Account temporarily locked after too many failed attempts. Try again after ${new Date(user.lockedUntilAt).toISOString()}`,
          );
        }
        if (!verifyPassword(input.password, user.passwordHash)) {
          user.failedLoginAttempts += 1;
          if (user.failedLoginAttempts >= 5) {
            user.lockedUntilAt = new Date(Date.now() + 15 * 60 * 1000);
          }
          throw new MockAuthError('Invalid email or password');
        }

        user.failedLoginAttempts = 0;
        user.lockedUntilAt = null;
        user.lastLoginAt = new Date();

        const session = generateSessionToken();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        dbState.userSessions.push({
          id: `usess_${randomUUID().slice(0, 8)}`,
          userId: user.id,
          tokenHash: session.hash,
          userAgent: input.userAgent ?? null,
          ipAddress: input.ipAddress ?? null,
          expiresAt,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
        });

        return { user: this.toPublic(user), token: session.raw, expiresAt };
      }

      async logout(rawToken: string) {
        const hash = hashToken(rawToken);
        const session = dbState.userSessions.find((s) => s.tokenHash === hash);
        if (session && !session.revokedAt) session.revokedAt = new Date();
      }

      async verifySession(rawToken: string) {
        const hash = hashToken(rawToken);
        const session = dbState.userSessions.find((s) => s.tokenHash === hash);
        if (!session || session.revokedAt) return null;
        if (new Date(session.expiresAt) < new Date()) return null;
        const user = dbState.users.find((u) => u.id === session.userId);
        if (!user) return null;
        session.lastUsedAt = new Date();
        return this.toPublic(user);
      }

      async requestPasswordReset(email: string) {
        const user = dbState.users.find((u) => u.email === email);
        if (!user) return null;
        for (const t of dbState.userVerificationTokens) {
          if (t.userId === user.id && t.purpose === 'password_reset' && !t.usedAt) t.usedAt = new Date();
        }
        const token = generateVerificationToken();
        dbState.userVerificationTokens.push({
          id: `uvt_${randomUUID().slice(0, 8)}`,
          userId: user.id,
          purpose: 'password_reset',
          tokenHash: token.hash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          usedAt: null,
          createdAt: new Date(),
        });
        return { token: token.raw };
      }

      async resetPassword(rawToken: string, newPassword: string) {
        if (!newPassword || newPassword.length < 8) {
          throw new MockValidationError('Password must be at least 8 characters');
        }
        const hash = hashToken(rawToken);
        const record = dbState.userVerificationTokens.find((t) => t.tokenHash === hash);
        if (!record || record.purpose !== 'password_reset' || record.usedAt || new Date(record.expiresAt) < new Date()) {
          throw new MockAuthError('Invalid or expired reset token');
        }
        const user = dbState.users.find((u) => u.id === record.userId);
        if (user) {
          user.passwordHash = hashPassword(newPassword);
          user.failedLoginAttempts = 0;
          user.lockedUntilAt = null;
        }
        record.usedAt = new Date();
        for (const s of dbState.userSessions) {
          if (s.userId === record.userId && !s.revokedAt) s.revokedAt = new Date();
        }
      }

      async resendEmailVerification(userId: string) {
        for (const t of dbState.userVerificationTokens) {
          if (t.userId === userId && t.purpose === 'email_verification' && !t.usedAt) t.usedAt = new Date();
        }
        const token = generateVerificationToken();
        dbState.userVerificationTokens.push({
          id: `uvt_${randomUUID().slice(0, 8)}`,
          userId,
          purpose: 'email_verification',
          tokenHash: token.hash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          usedAt: null,
          createdAt: new Date(),
        });
        return { token: token.raw };
      }

      async verifyEmail(rawToken: string) {
        const hash = hashToken(rawToken);
        const record = dbState.userVerificationTokens.find((t) => t.tokenHash === hash);
        if (
          !record ||
          record.purpose !== 'email_verification' ||
          record.usedAt ||
          new Date(record.expiresAt) < new Date()
        ) {
          throw new MockAuthError('Invalid or expired verification token');
        }
        const user = dbState.users.find((u) => u.id === record.userId);
        if (!user) throw new MockAuthError('User not found');
        user.emailVerifiedAt = new Date();
        record.usedAt = new Date();
        return this.toPublic(user);
      }
    },
    // Backs packages/providers' ProviderRegistry secrets-persistence
    // round trip (exportSecretsForPersistence/hydrateSecrets on the
    // registry side; ensureProviderRow/persistProviderSecrets/
    // loadAllProviderSecrets here) — see services/api-gateway/src/app.ts's
    // hydrateProviderSecretsFromDb()/persistProviderSecretsAsync(). Mirrors
    // the real packages/database/src/provider-secrets.ts logic against
    // dbState instead of Postgres; uses the real encryptSecret/
    // decryptSecret so a round trip here behaves identically to
    // production, including failing to decrypt if SECRET_ENCRYPTION_KEY
    // isn't set.
    providerRepository: {
      async findById(id: string) {
        return dbState.providers.find((p) => p.id === id);
      },
      async findBySlug(slug: string) {
        return dbState.providers.find((p) => p.slug === slug);
      },
      async findAll() {
        return dbState.providers.slice();
      },
      async create(data: { slug: string; name: string; category: string }) {
        const row: ProviderRow = {
          id: `prov_${randomUUID().slice(0, 8)}`,
          slug: data.slug,
          name: data.name,
          category: data.category,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.providers.push(row);
        return row;
      },
      async upsertBySlug(data: { slug: string; name: string; category: string }) {
        const existing = dbState.providers.find((p) => p.slug === data.slug);
        if (existing) {
          existing.name = data.name;
          existing.category = data.category;
          existing.updatedAt = new Date();
          return existing;
        }
        const row: ProviderRow = {
          id: `prov_${randomUUID().slice(0, 8)}`,
          slug: data.slug,
          name: data.name,
          category: data.category,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.providers.push(row);
        return row;
      },
    },
    providerConfigRepository: {
      async findByProviderAndEnvironment(providerId: string, environment: string) {
        return dbState.providerConfigs.find((c) => c.providerId === providerId && c.environment === environment);
      },
      async create(data: {
        providerId: string;
        environment: string;
        encryptedSecret?: string | null;
        secretIv?: string | null;
        secretTag?: string | null;
      }) {
        const row: ProviderConfigRow = {
          id: `pcfg_${randomUUID().slice(0, 8)}`,
          providerId: data.providerId,
          environment: data.environment,
          encryptedSecret: data.encryptedSecret ?? null,
          secretIv: data.secretIv ?? null,
          secretTag: data.secretTag ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.providerConfigs.push(row);
        return row;
      },
      async update(id: string, data: Partial<ProviderConfigRow>) {
        const row = dbState.providerConfigs.find((c) => c.id === id);
        if (!row) return undefined;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    // Mirrors packages/database/src/repositories/webhook-endpoints.ts —
    // real encryptSecret/decryptSecret round trip, same generated
    // 'whsec_...' secret shape, against dbState instead of Postgres.
    webhookEndpointRepository: {
      async findById(id: string) {
        return dbState.webhookEndpoints.find((w) => w.id === id);
      },
      // Phase 7 (C4/F3.2): every read is (appId, tenantId)-scoped, mirroring
      // the real repository — there is no app-only variant any more.
      async findByAppAndTenant(appId: string, tenantId: string) {
        return dbState.webhookEndpoints
          .filter((w) => w.appId === appId && w.tenantId === tenantId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async findActiveByAppAndTenant(appId: string, tenantId: string) {
        return dbState.webhookEndpoints.filter((w) => w.appId === appId && w.tenantId === tenantId && w.active);
      },
      async create(data: { appId: string; tenantId: string; url: string; eventTypes?: string[] }) {
        const validCategories = new Set(['payment', 'messaging', 'other', '*']);
        const eventTypes = data.eventTypes && data.eventTypes.length > 0 ? data.eventTypes : ['*'];
        const invalid = eventTypes.filter((e) => !validCategories.has(e));
        if (invalid.length > 0) {
          throw new Error(`Invalid event type(s): ${invalid.join(', ')} — expected one of payment, messaging, other, *`);
        }
        const secret = 'whsec_' + randomUUID().replace(/-/g, '');
        const payload = encryptSecret(secret);
        const row: WebhookEndpointRow = {
          id: `wh_${randomUUID().slice(0, 12)}`,
          appId: data.appId,
          tenantId: data.tenantId,
          url: data.url,
          encryptedSecret: payload.encrypted,
          secretIv: payload.iv,
          secretTag: payload.tag,
          eventTypes,
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.webhookEndpoints.push(row);
        return { endpoint: row, secret };
      },
      async setActive(id: string, active: boolean) {
        const row = dbState.webhookEndpoints.find((w) => w.id === id);
        if (!row) return undefined;
        row.active = active;
        row.updatedAt = new Date();
        return row;
      },
      async deleteScoped(id: string, appId: string, tenantId: string) {
        const idx = dbState.webhookEndpoints.findIndex((w) => w.id === id && w.appId === appId && w.tenantId === tenantId);
        if (idx === -1) return false;
        dbState.webhookEndpoints.splice(idx, 1);
        return true;
      },
      resolveSecret(endpoint: WebhookEndpointRow) {
        return decryptSecret({ encrypted: endpoint.encryptedSecret, iv: endpoint.secretIv, tag: endpoint.secretTag });
      },
    },
    encryptSecret,
    decryptSecret,
    hashPassword,
    verifyPassword,
    generateApiKey,
    currentDeploymentTier(): 'live' | 'test' {
      return process.env.NODE_ENV === 'production' ? 'live' : 'test';
    },
    async ensureProviderRow(input: { slug: string; name: string; category: string }): Promise<string> {
      const existing = dbState.providers.find((p) => p.slug === input.slug);
      if (existing) {
        existing.name = input.name;
        existing.category = input.category;
        existing.updatedAt = new Date();
        return existing.id;
      }
      const row: ProviderRow = {
        id: `prov_${randomUUID().slice(0, 8)}`,
        slug: input.slug,
        name: input.name,
        category: input.category,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      dbState.providers.push(row);
      return row.id;
    },
    async persistProviderSecrets(
      slug: string,
      secrets: { field: string; label: string; value: string }[],
    ): Promise<void> {
      if (!process.env.SECRET_ENCRYPTION_KEY) return;
      const provider = dbState.providers.find((p) => p.slug === slug);
      if (!provider) return;

      const environment = process.env.NODE_ENV === 'production' ? 'live' : 'test';
      const payload: EncryptedPayload = encryptSecret(JSON.stringify(secrets));
      const existing = dbState.providerConfigs.find(
        (c) => c.providerId === provider.id && c.environment === environment,
      );
      if (existing) {
        existing.encryptedSecret = payload.encrypted;
        existing.secretIv = payload.iv;
        existing.secretTag = payload.tag;
        existing.updatedAt = new Date();
      } else {
        dbState.providerConfigs.push({
          id: `pcfg_${randomUUID().slice(0, 8)}`,
          providerId: provider.id,
          environment,
          encryptedSecret: payload.encrypted,
          secretIv: payload.iv,
          secretTag: payload.tag,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    },
    async loadAllProviderSecrets(): Promise<Record<string, { field: string; label: string; value: string }[]>> {
      if (!process.env.SECRET_ENCRYPTION_KEY) return {};
      const environment = process.env.NODE_ENV === 'production' ? 'live' : 'test';
      const snapshot: Record<string, { field: string; label: string; value: string }[]> = {};

      for (const provider of dbState.providers) {
        const config = dbState.providerConfigs.find(
          (c) => c.providerId === provider.id && c.environment === environment,
        );
        if (!config?.encryptedSecret || !config.secretIv || !config.secretTag) continue;
        try {
          const json = decryptSecret({ encrypted: config.encryptedSecret, iv: config.secretIv, tag: config.secretTag });
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) snapshot[provider.slug] = parsed;
        } catch {
          // Same as the real implementation: skip a row that fails to
          // decrypt rather than blocking every other provider's secrets.
        }
      }
      return snapshot;
    },
    checkDatabaseHealth: async () => {
      if (dbState.failEventWrites) {
        return { status: 'unhealthy', latencyMs: 1, details: { error: 'simulated down' } };
      }
      return { status: 'healthy', latencyMs: 5, details: {} };
    },
  };
}