import { randomBytes } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { webhookEndpoints, type WebhookEndpoint } from '../schema';
import { encryptSecret, decryptSecret } from '../crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_CATEGORIES = new Set(['payment', 'messaging', 'other', '*']);

function normalizeEventTypes(eventTypes?: string[]): string[] {
  if (!eventTypes || eventTypes.length === 0) return ['*'];
  const invalid = eventTypes.filter((e) => !VALID_CATEGORIES.has(e));
  if (invalid.length > 0) {
    throw new Error(`Invalid event type(s): ${invalid.join(', ')} — expected one of payment, messaging, other, *`);
  }
  return eventTypes;
}

export const webhookEndpointRepository = {
  async findById(id: string): Promise<WebhookEndpoint | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const db = getDb();
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    return rows[0];
  },

  // Phase 7 (gap register C4 / F3.2): every read is scoped by BOTH appId and
  // tenantId. This used to be findByAppId(appId) / findActiveByAppId(appId),
  // which returned — and dispatched every event to — every tenant's
  // endpoints under the application: tenant B received tenant A's payment
  // payloads (amount, phone, payment id) and could list tenant A's
  // registrations. There is deliberately no app-only variant any more, so
  // nothing can quietly reintroduce the cross-tenant read.
  async findByAppAndTenant(appId: string, tenantId: string): Promise<WebhookEndpoint[]> {
    const db = getDb();
    return db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.appId, appId), eq(webhookEndpoints.tenantId, tenantId)))
      .orderBy(desc(webhookEndpoints.createdAt));
  },

  // The active endpoints an event is dispatched to: the event's own
  // (appId, tenantId) only.
  async findActiveByAppAndTenant(appId: string, tenantId: string): Promise<WebhookEndpoint[]> {
    const db = getDb();
    return db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.appId, appId),
          eq(webhookEndpoints.tenantId, tenantId),
          eq(webhookEndpoints.active, true),
        ),
      );
  },

  // Generates a fresh signing secret, encrypts it at rest, and returns the
  // plaintext secret exactly once — the caller (the HTTP route) is
  // responsible for handing it to the developer now, since it can never be
  // recovered again (only re-generated via delete + create).
  async create(data: {
    appId: string;
    tenantId: string;
    url: string;
    eventTypes?: string[];
  }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const eventTypes = normalizeEventTypes(data.eventTypes);
    const secret = 'whsec_' + randomBytes(24).toString('hex');
    const payload = encryptSecret(secret);

    const db = getDb();
    const rows = await db
      .insert(webhookEndpoints)
      .values({
        appId: data.appId,
        tenantId: data.tenantId,
        url: data.url,
        encryptedSecret: payload.encrypted,
        secretIv: payload.iv,
        secretTag: payload.tag,
        eventTypes,
      })
      .returning();
    return { endpoint: rows[0], secret };
  },

  async setActive(id: string, active: boolean): Promise<WebhookEndpoint | undefined> {
    const db = getDb();
    const rows = await db
      .update(webhookEndpoints)
      .set({ active, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return rows[0];
  },

  // Scoped to the caller's own (appId, tenantId) — a delete for an endpoint
  // owned by another application OR another tenant of the same application
  // is a no-op (returns false → the route answers 404, never revealing that
  // the id exists). Phase 7: this used to match on appId only, so tenant B
  // could delete tenant A's endpoint. A malformed (non-UUID) id is also a
  // plain "not found" rather than a Postgres cast error (500).
  async deleteScoped(id: string, appId: string, tenantId: string): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const db = getDb();
    const rows = await db
      .delete(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.appId, appId),
          eq(webhookEndpoints.tenantId, tenantId),
        ),
      )
      .returning();
    return rows.length > 0;
  },

  // Decrypts the endpoint's signing secret for delivery-time HMAC signing.
  // Never exposed back over HTTP after creation.
  resolveSecret(endpoint: WebhookEndpoint): string {
    return decryptSecret({
      encrypted: endpoint.encryptedSecret,
      iv: endpoint.secretIv,
      tag: endpoint.secretTag,
    });
  },
};
