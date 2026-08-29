import { createHash, randomUUID } from 'node:crypto';

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
      async countByCategory(): Promise<Record<string, number>> {
        if (dbState.failEventWrites) {
          throw new Error('database unavailable (simulated): connection refused');
        }
        const out: Record<string, number> = {};
        for (const e of dbState.events) {
          out[e.category] = (out[e.category] ?? 0) + 1;
        }
        return out;
      },
      async countSince(since: Date): Promise<number> {
        return dbState.events.filter((e) => e.createdAt >= since).length;
      },
      async findLatest(limit = 100): Promise<EventRow[]> {
        return dbState.events.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
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
      async findRecent(limit = 50): Promise<AuditLogRow[]> {
        return dbState.auditLogs.slice(0, limit);
      },
      async findByAction(action: string, limit = 100): Promise<AuditLogRow[]> {
        return dbState.auditLogs.filter((a) => a.action === action).slice(0, limit);
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
    // P0: Mock runInTransaction — just runs the function directly in simulation
    runInTransaction: async (fn: (tx: any) => Promise<any>) => {
      return fn(null);
    },
    ApplicationRegistry: class {
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
    checkDatabaseHealth: async () => {
      if (dbState.failEventWrites) {
        return { status: 'unhealthy', latencyMs: 1, details: { error: 'simulated down' } };
      }
      return { status: 'healthy', latencyMs: 5, details: {} };
    },
  };
}