import { randomBytes } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../connection';
import { webhookEndpoints, type WebhookEndpoint } from '../schema';
import { encryptSecret, decryptSecret } from '../crypto';

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
    const db = getDb();
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    return rows[0];
  },

  async findByAppId(appId: string): Promise<WebhookEndpoint[]> {
    const db = getDb();
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.appId, appId))
      .orderBy(desc(webhookEndpoints.createdAt));
  },

  // Every active endpoint registered for the appId an event was emitted
  // for — TransactionEvent carries no tenantId, so dispatch can only key
  // on appId (see the schema file's class comment).
  async findActiveByAppId(appId: string): Promise<WebhookEndpoint[]> {
    const db = getDb();
    return db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.appId, appId), eq(webhookEndpoints.active, true)));
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

  // Scoped to the caller's own appId — a delete for an endpoint owned by
  // another application is a no-op (returns false), not a 500, matching
  // the ownership pattern the refund route uses for transactions.
  async deleteScoped(id: string, appId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.appId, appId)))
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
