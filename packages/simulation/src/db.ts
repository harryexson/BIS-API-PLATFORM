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
} from '../../database/src/crypto';

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
  createdAt: Date;
  updatedAt: Date;
}

export interface DbState {
  failEventWrites: boolean;
  failAuditWrites: boolean;
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
  users: UserRow[];
  userSessions: UserSessionRow[];
  userVerificationTokens: UserVerificationTokenRow[];
  roles: RoleRow[];
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
  events: [],
  auditLogs: [],
  applications: [],
  apiKeys: [],
  tenants: [],
  tenantLinks: [],
  conversations: [],
  consentRecords: [],
  messagingProfiles: [],
  users: [],
  userSessions: [],
  userVerificationTokens: [],
  roles: [],
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

export function clearDb(): void {
  dbState.failEventWrites = false;
  dbState.failAuditWrites = false;
  dbState.events = [];
  dbState.auditLogs = [];
  dbState.applications = [];
  dbState.apiKeys = [];
  dbState.tenants = [];
  dbState.tenantLinks = [];
  dbState.conversations = [];
  dbState.consentRecords = [];
  dbState.messagingProfiles = [];
  dbState.users = [];
  dbState.userSessions = [];
  dbState.userVerificationTokens = [];
  dbState.roles = [];
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
    applicationId: APP_SLUG,
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
    applicationId: OTHER_APP_SLUG,
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
    applicationId: AFRIBOOK_SLUG,
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
        return dbState.applications.find((a) => a.id === id);
      },
      async findBySlug(slug: string) {
        return dbState.applications.find((a) => a.slug === slug);
      },
      async findByName(name: string) {
        return dbState.applications.find((a) => a.name === name);
      },
      async create(data: Record<string, unknown>) {
        const row = { id: `app_${randomUUID().slice(0, 8)}`, slug: String(data.slug), name: String(data.name), status: 'active', environment: 'development' };
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
      // P1-2 FIX: Include tenantId in lookup to match real repository behavior.
      async findByPhoneAndApp(
        phoneNumber: string,
        appId: string,
        tenantId: string = 'default',
      ): Promise<ConversationRow | undefined> {
        return dbState.conversations.find(
          (c) => c.phoneNumber === phoneNumber && c.appId === appId && c.tenantId === tenantId,
        );
      },
      async findActiveByPhone(phoneNumber: string): Promise<ConversationRow[]> {
        return dbState.conversations.filter(
          (c) => c.phoneNumber === phoneNumber && c.status === 'active',
        );
      },
      async upsert(
        phoneNumber: string,
        appId: string,
        data: { providerId: string; channel: string; tenantId: string },
      ): Promise<ConversationRow> {
        const existing = dbState.conversations.find(
          (c) => c.phoneNumber === phoneNumber && c.appId === appId && c.tenantId === data.tenantId,
        );
        if (existing) {
          existing.providerId = data.providerId;
          existing.channel = data.channel;
          existing.status = 'active';
          existing.lastMessageAt = new Date();
          existing.updatedAt = new Date();
          return existing;
        }
        const row: ConversationRow = {
          id: `conv_${randomUUID().slice(0, 12)}`,
          phoneNumber,
          appId,
          tenantId: data.tenantId,
          providerId: data.providerId,
          channel: data.channel,
          status: 'active',
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.conversations.push(row);
        return row;
      },
      // P1-2 FIX: Include tenantId in close to match real repository behavior.
      async close(
        phoneNumber: string,
        appId: string,
        tenantId: string = 'default',
      ): Promise<boolean> {
        const existing = dbState.conversations.find(
          (c) => c.phoneNumber === phoneNumber && c.appId === appId && c.tenantId === tenantId,
        );
        if (!existing) return false;
        existing.status = 'closed';
        existing.updatedAt = new Date();
        return true;
      },
      async count(): Promise<number> {
        return dbState.conversations.length;
      },
    },
    // P0: Mock transaction repository for payment state tracking
    transactionRepository: {
      async findById(id: string) {
        return undefined;
      },
      async findByProviderTransactionId(_providerTxId: string) {
        return undefined;
      },
      async create(data: Record<string, unknown>) {
        const row = {
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
        return row as any;
      },
      async updateStatus(_id: string, _status: string) {
        return undefined;
      },
      async findByAppAndIdempotencyKey(_appId: string, _tenantId: string, _key: string) {
        return undefined;
      },
      async findByAppId(_appId: string, _limit = 50) {
        return [];
      },
      async count() {
        return 0;
      },
    },
    // P0: Mock outbox event repository for transactional outbox pattern
    outboxEventRepository: {
      async create(data: Record<string, unknown>) {
        return {
          id: `ob_${randomUUID().slice(0, 12)}`,
          appId: String(data.appId ?? ''),
          eventType: String(data.eventType ?? ''),
          payload: data.payload ?? {},
          status: 'pending',
          createdAt: new Date(),
          processedAt: null,
          error: null,
        } as any;
      },
      async claimBatch(_limit = 10) {
        return [];
      },
      async complete(_id: string) {},
      async fail(_id: string, _error: string) {},
      async findPending() {
        return [];
      },
      async count() {
        return 0;
      },
    },
    // P0: Mock idempotency record repository
    idempotencyRecordRepository: {
      async findActive(_appId: string, _tenantId: string, _operation: string, _key: string) {
        return undefined;
      },
      async create(data: Record<string, unknown>) {
        return {
          id: `idem_${randomUUID().slice(0, 12)}`,
          appId: data.appId,
          tenantId: data.tenantId,
          operation: data.operation,
          idempotencyKey: data.idempotencyKey,
          status: data.status ?? 'pending',
          result: null,
          createdAt: new Date(),
          expiresAt: data.expiresAt,
        } as any;
      },
      async complete(_id: string, _result: any) {},
      async fail(_id: string, _error: string) {},
      async count() {
        return 0;
      },
    },
    // P0: Mock supplier repository
    supplierRepository: {
      async findById(_id: string) {
        return undefined;
      },
      async findByApplicationAndSlug(_appId: string, _tenantId: string, _slug: string) {
        return undefined;
      },
      async create(data: Record<string, unknown>) {
        return { id: `sup_${randomUUID().slice(0, 12)}`, ...data } as any;
      },
      async update(_id: string, _data: Record<string, unknown>) {
        return undefined;
      },
      async findByApplicationId(_appId: string) {
        return [];
      },
      async count() {
        return 0;
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
        return dbState.messagingProfiles.find(
          (p) => p.appId === appId && p.tenantId === tenantId && p.sender === sender && p.provider === provider,
        );
      },
      async findByApplicationId(appId: string, limit = 100) {
        return dbState.messagingProfiles.filter((p) => p.appId === appId).slice(0, limit);
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
          sender: data.sender,
          provider: data.provider,
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
    checkDatabaseHealth: async () => {
      if (dbState.failEventWrites) {
        return { status: 'unhealthy', latencyMs: 1, details: { error: 'simulated down' } };
      }
      return { status: 'healthy', latencyMs: 5, details: {} };
    },
  };
}