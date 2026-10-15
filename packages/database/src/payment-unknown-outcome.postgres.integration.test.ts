import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createPaymentAttemptRepository } from './repositories/transactions';
import { createWebhookEventRepository } from './repositories/webhook-events';
import { paymentOutcomeFromEvent, transactionStatusesAllowedInto } from './transaction-status';

/**
 * Phase 6 proof against a REAL PostgreSQL server: gap register D4 — the
 * certification scenario "network death after the provider processes but
 * before the response is received must mark UNKNOWN, never blindly retry a
 * potentially-chargeable operation".
 *
 * Drives the REAL RoutingEngine (with the real ProviderRegistry and its 14
 * payment adapters) against a provider that never answers, then records the
 * outcome with the same mapping the gateway uses (paymentOutcomeFromEvent)
 * through the production repository SQL.
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/payment-unknown-outcome.postgres.integration.test.ts
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');
const TIMEOUT_MS = 300;

describe.skipIf(!ADMIN_URL)('Phase 6 — ambiguous provider outcome (timeout) on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let repo: ReturnType<typeof createPaymentAttemptRepository>;
  let webhooks: ReturnType<typeof createWebhookEventRepository>;
  const dbName = `bis_p6u_${randomBytes(6).toString('hex')}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routing: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registry: any;
  const calls: Record<string, number> = {};
  const restores: Array<() => void> = [];
  let prevTimeout: string | undefined;

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    client = postgres(u.toString(), { max: 10, onnotice: () => {} });
    db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await client`
      INSERT INTO applications (name, slug, description, status, environment)
      VALUES ('Phase 6 test app', 'app_p6u', 'unknown outcome test', 'active', 'production')`;
    repo = createPaymentAttemptRepository(() => db as never);
    webhooks = createWebhookEventRepository(() => db as never);

    // PROVIDER_TIMEOUT_MS is read when @company/routing is first loaded.
    prevTimeout = process.env.PROVIDER_TIMEOUT_MS;
    process.env.PROVIDER_TIMEOUT_MS = String(TIMEOUT_MS);
    const routingMod = await import('@company/routing');
    const providersMod = await import('@company/providers');
    routing = new routingMod.RoutingEngine();
    registry = providersMod.ProviderRegistry.getInstance();
  }, 60_000);

  afterAll(async () => {
    if (prevTimeout === undefined) delete process.env.PROVIDER_TIMEOUT_MS;
    else process.env.PROVIDER_TIMEOUT_MS = prevTimeout;
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  afterEach(() => {
    while (restores.length) restores.pop()!();
    for (const k of Object.keys(calls)) delete calls[k];
  });

  /** Counts processRequest/refund on EVERY payment adapter; `hang` never answers. */
  function instrumentPaymentProviders(hang: string) {
    for (const cfg of registry.getAllConfigs().filter((c: { category: string }) => c.category === 'payment')) {
      const p = registry.getProvider(cfg.id);
      const origProcess = p.processRequest;
      const origRefund = p.refund;
      p.processRequest = async (...args: unknown[]) => {
        calls[`${cfg.id}.processRequest`] = (calls[`${cfg.id}.processRequest`] ?? 0) + 1;
        if (cfg.id === hang) return new Promise(() => {}); // network death: no response, ever
        return origProcess.apply(p, args);
      };
      p.refund = async (...args: unknown[]) => {
        calls[`${cfg.id}.refund`] = (calls[`${cfg.id}.refund`] ?? 0) + 1;
        return origRefund.apply(p, args);
      };
      restores.push(() => {
        p.processRequest = origProcess;
        p.refund = origRefund;
      });
    }
  }

  const totalCalls = () => Object.values(calls).reduce((a, b) => a + b, 0);

  it(
    'a provider timeout is stored as the distinct UNKNOWN status on the real pre-allocated row id (provider_transaction_id NULL, never a random UUID), with no failover charge',
    async () => {
      instrumentPaymentProviders('stripe');
      const row = (await repo.allocate({
        appId: 'app_p6u',
        tenantId: 'ten_p6u',
        amount: '42',
        currency: 'USD',
        paymentMethod: 'card',
        idempotencyKey: 'order-timeout-1',
      }))!;
      expect(row.status).toBe('processing');

      const event = await routing.routePayment('app_p6u', {
        amount: 42,
        currency: 'USD',
        paymentMethod: 'card',
        providerOverride: 'stripe',
        paymentToken: 'pm_card_visa',
        idempotencyKey: 'order-timeout-1',
        paymentTransactionId: row.id,
      });

      // The routing outcome: ambiguous, identified by the platform's own stable id.
      expect(event.status).toBe('unknown');
      expect(event.providerId).toBe('stripe');
      expect(event.id).toBe(row.id);
      expect(event.paymentTransactionId).toBe(row.id);
      // Exactly one provider call — to the provider that timed out. No cascade.
      expect(calls).toEqual({ 'stripe.processRequest': 1 });

      const outcome = paymentOutcomeFromEvent(row.id, event, 'USD');
      expect(outcome).toMatchObject({ status: 'unknown', providerTransactionId: null, providerId: 'stripe' });
      const stored = await repo.recordOutcome(row.id, outcome);
      expect(stored).toBeDefined();

      const [r] = await client`
        SELECT id, status, provider_id, provider_transaction_id, outcome_unknown_at, reconciliation_reason
        FROM transactions WHERE id = ${row.id}`;
      expect(r.id).toBe(row.id);
      expect(r.status).toBe('unknown'); // NOT collapsed into 'pending' (D4)
      expect(r.provider_id).toBe('stripe');
      expect(r.provider_transaction_id).toBeNull(); // no throwaway randomUUID()
      expect(r.outcome_unknown_at).not.toBeNull();
      expect(r.reconciliation_reason).toMatch(/^provider_timeout: /);
      const [{ n }] = await client`SELECT count(*)::int AS n FROM transactions WHERE idempotency_key = 'order-timeout-1'`;
      expect(n).toBe(1);
    },
    15_000,
  );

  it('an UNKNOWN payment is never re-opened or re-allocated for another charge attempt by any repository path', async () => {
    instrumentPaymentProviders('none');
    const row = (await repo.allocate({ appId: 'app_p6u', tenantId: 'ten_p6u', amount: '9', currency: 'USD', idempotencyKey: 'order-timeout-2' }))!;
    await repo.recordOutcome(row.id, { providerId: 'stripe', providerTransactionId: null, status: 'unknown', reconciliationReason: 'provider_timeout: test' });

    // Same Idempotency-Key retry: allocation loses on the unique index (the gateway answers 409).
    expect(await repo.allocate({ appId: 'app_p6u', tenantId: 'ten_p6u', amount: '9', currency: 'USD', idempotencyKey: 'order-timeout-2' })).toBeUndefined();
    // The only "retry" path (reopen a failed attempt) refuses — the row is not failed...
    expect(await repo.reopenFailed(row.id)).toBeUndefined();
    // ...and no generic transition can move it back to processing...
    expect((await repo.transitionStatus(row.id, 'processing')).outcome).toBe('rejected');
    // ...and even after an operator later records it as failed, it is still
    // never re-opened (it was ambiguous once: it may have been charged).
    expect((await repo.transitionStatus(row.id, 'requires_reconciliation')).outcome).toBe('applied');
    expect((await repo.transitionStatus(row.id, 'failed', { resolution: { source: 'operator', note: 'test' } })).outcome).toBe('applied');
    expect(await repo.reopenFailed(row.id)).toBeUndefined();
    const [r] = await client`SELECT status FROM transactions WHERE id = ${row.id}`;
    expect(r.status).toBe('failed');
    expect(totalCalls()).toBe(0);

    // Control: a failed attempt that was NEVER ambiguous (routing threw before any provider result) still reopens.
    const plain = (await repo.allocate({ appId: 'app_p6u', tenantId: 'ten_p6u', amount: '9', currency: 'USD', idempotencyKey: 'order-plain-fail' }))!;
    await repo.recordOutcome(plain.id, { providerId: 'failed_route', providerTransactionId: null, status: 'failed' });
    expect((await repo.reopenFailed(plain.id))?.id).toBe(plain.id);
  });

  it("the provider's own later webhook resolves the UNKNOWN row via metadata.bisPaymentTransactionId, filling in the provider id", async () => {
    const row = (await repo.allocate({ appId: 'app_p6u', tenantId: 'ten_p6u', amount: '15', currency: 'USD', idempotencyKey: 'order-timeout-3' }))!;
    await repo.recordOutcome(row.id, { providerId: 'stripe', providerTransactionId: null, status: 'unknown', reconciliationReason: 'provider_timeout: test' });

    // A webhook from a DIFFERENT provider claiming the same platform id is not matched.
    const foreign = await webhooks.persistEffectsOnce({
      idempotencyKey: 'webhook:p6u-foreign:payment_webhook',
      event: { appId: 'app_p6u', category: 'payment_webhook', providerId: 'nmi', status: 'success', decisionReason: 'payment_webhook_received', payload: {} },
      transactionStatus: { providerTransactionId: 'nmi_999', toStatus: 'success', allowedFrom: transactionStatusesAllowedInto('success'), paymentTransactionId: row.id },
    });
    expect(foreign.transactionUpdated).toBe(false);

    const res = await webhooks.persistEffectsOnce({
      idempotencyKey: 'webhook:p6u-late:payment_webhook',
      event: { appId: 'app_p6u', category: 'payment_webhook', providerId: 'stripe', status: 'success', decisionReason: 'payment_webhook_received', payload: {} },
      transactionStatus: { providerTransactionId: 'pi_late_confirmed', toStatus: 'success', allowedFrom: transactionStatusesAllowedInto('success'), paymentTransactionId: row.id },
    });
    expect(res).toMatchObject({ inserted: true, transactionUpdated: true });
    const [r] = await client`
      SELECT status, provider_transaction_id, reconciliation_resolved_at, reconciliation_resolution
      FROM transactions WHERE id = ${row.id}`;
    expect(r.status).toBe('success');
    expect(r.provider_transaction_id).toBe('pi_late_confirmed');
    expect(r.reconciliation_resolved_at).not.toBeNull();
    expect(r.reconciliation_resolution).toMatchObject({ source: 'provider_webhook', providerTransactionId: 'pi_late_confirmed' });

    // A row that already has a provider id is never re-pointed by the fallback.
    const other = (await repo.allocate({ appId: 'app_p6u', tenantId: 'ten_p6u', amount: '15', currency: 'USD', idempotencyKey: 'order-known' }))!;
    await repo.recordOutcome(other.id, { providerId: 'stripe', providerTransactionId: 'pi_known', status: 'unknown' });
    const mis = await webhooks.persistEffectsOnce({
      idempotencyKey: 'webhook:p6u-mis:payment_webhook',
      event: { appId: 'app_p6u', category: 'payment_webhook', providerId: 'stripe', status: 'success', decisionReason: 'payment_webhook_received', payload: {} },
      transactionStatus: { providerTransactionId: 'pi_someone_else', toStatus: 'success', allowedFrom: transactionStatusesAllowedInto('success'), paymentTransactionId: other.id },
    });
    expect(mis.transactionUpdated).toBe(false);
    const [o] = await client`SELECT status, provider_transaction_id FROM transactions WHERE id = ${other.id}`;
    expect(o).toEqual({ status: 'unknown', provider_transaction_id: 'pi_known' });
  });
});
