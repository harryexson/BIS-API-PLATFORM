import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createPaymentAttemptRepository } from './repositories/transactions';
import {
  createReconciliationProcessor,
  createWorkerConfig,
  runPaymentReconciliationOnce,
  resolvePaymentReconciliationConfig,
  type JobDeps,
  type Job,
  type PaymentReconciliationReport,
} from '@company/workers';
import { ProviderRegistry } from '@company/providers';

/**
 * Phase 6 proof against a REAL PostgreSQL server: the payment
 * reconciliation job (gap register D4 / PHASE3-02).
 *
 *   TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     npx vitest run packages/database/src/payment-reconciliation.postgres.integration.test.ts
 *
 * Uses the REAL ProviderRegistry (all 14 payment adapters, each instrumented
 * so ANY processRequest/refund call is counted), the REAL Stripe adapter with
 * a test key, and a fetch stub standing in for Stripe's API (recording every
 * request). No real Stripe account/sandbox is reachable from this sandbox, so
 * the Stripe responses are fixtures shaped after Stripe's public API
 * reference — the point proven here is the platform's behaviour, not
 * Stripe's.
 */

const ADMIN_URL = process.env.TEST_POSTGRES_URL;
const MIGRATIONS = path.resolve(__dirname, '../drizzle');
const MIN = 60_000;

describe.skipIf(!ADMIN_URL)('Phase 6 — payment reconciliation job on real Postgres', () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase;
  let repo: ReturnType<typeof createPaymentAttemptRepository>;
  const dbName = `bis_p6r_${randomBytes(6).toString('hex')}`;

  const registry = ProviderRegistry.getInstance();
  const moneyCalls: string[] = [];
  const restores: Array<() => void> = [];
  const http: Array<{ method: string; url: string }> = [];
  let realFetch: typeof fetch;
  const ids: Record<string, string> = {};

  /** Stripe API fixtures (GET only — anything else is recorded and answered 500). */
  const intents: Record<string, Record<string, unknown>> = {};
  const searchResults: Record<string, Array<Record<string, unknown>>> = {};

  async function seed(
    key: string,
    row: { status: string; providerId: string; ptx?: string | null; ageMin: number; amount?: string; unknownForMin?: number | null },
  ) {
    const [r] = await client`
      INSERT INTO transactions (app_id, tenant_id, provider_id, provider_transaction_id, status, amount, currency,
                                idempotency_key, created_at, updated_at, outcome_unknown_at)
      VALUES ('app_p6r', 'ten_p6r', ${row.providerId}, ${row.ptx ?? null}, ${row.status}, ${row.amount ?? '15.00'}, 'USD', ${key},
              now() - make_interval(mins => ${row.ageMin}), now() - make_interval(mins => ${row.ageMin}),
              ${row.unknownForMin == null ? null : client`now() - make_interval(mins => ${row.unknownForMin})`})
      RETURNING id`;
    ids[key] = r.id as string;
  }

  async function row(key: string) {
    const [r] = await client`
      SELECT status, provider_transaction_id AS ptx, reconciliation_reason AS reason, reconciliation_check_count AS checks,
             reconciliation_resolution AS resolution, reconciliation_required_at AS required_at
      FROM transactions WHERE id = ${ids[key]}`;
    return r;
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    client = postgres(u.toString(), { max: 10, onnotice: () => {} });
    db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = createPaymentAttemptRepository(() => db as never);

    // Count EVERY money-moving call on EVERY payment adapter.
    for (const cfg of registry.getAllConfigs().filter((c) => c.category === 'payment')) {
      const p = registry.getProvider(cfg.id)! as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const method of ['processRequest', 'refund']) {
        const orig = p[method];
        p[method] = function (this: unknown, ...args: unknown[]) {
          moneyCalls.push(`${cfg.id}.${method}`);
          return orig.apply(this, args);
        };
        restores.push(() => {
          p[method] = orig;
        });
      }
    }
    // The real Stripe adapter, configured with a (test) key so its read-only status query is live.
    const stripe = registry.getProvider('stripe')!;
    stripe.setSecrets({ api_key: 'sk_test_phase6_reconciliation' });
    restores.push(() => stripe.setSecrets({}));

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      http.push({ method, url });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method !== 'GET') return json(500, { error: { message: 'test: only GET is expected' } });
      const u = new URL(url);
      if (u.pathname === '/v1/payment_intents/search') {
        const m = /metadata\['bisPaymentTransactionId'\]:'([0-9a-f-]+)'/.exec(u.searchParams.get('query') ?? '');
        return json(200, { object: 'search_result', data: (m && searchResults[m[1]]) || [], has_more: false });
      }
      const pi = /^\/v1\/payment_intents\/([^/]+)$/.exec(u.pathname)?.[1];
      if (pi && intents[pi]) return json(200, intents[pi]);
      return json(404, { error: { type: 'invalid_request_error', message: `No such payment_intent: '${pi}'` } });
    }) as typeof fetch;
    restores.push(() => {
      globalThis.fetch = realFetch;
    });

    // ---- the payments under test -------------------------------------------
    // r1: ambiguous for 2h on a provider with NO status query (NMI) → escalate.
    await seed('r1', { status: 'unknown', providerId: 'nmi', ageMin: 120, unknownForMin: 120 });
    // r2: process crashed mid-call 30 min ago (PHASE3-02): 'processing', provider never recorded → escalate.
    await seed('r2', { status: 'processing', providerId: 'unassigned', ageMin: 30 });
    // r3: a payment genuinely in flight (1 min) → not touched.
    await seed('r3', { status: 'processing', providerId: 'stripe', ageMin: 1 });
    // r4: Stripe timeout 20 min ago, provider id never received; Stripe search finds it succeeded → resolved.
    await seed('r4', { status: 'unknown', providerId: 'stripe', ageMin: 20, unknownForMin: 20 });
    // r5: Stripe said requires_action 20 min ago (pi known); still requires_action → state refined, not escalated yet.
    await seed('r5', { status: 'unknown', providerId: 'stripe', ptx: 'pi_r5', ageMin: 20, unknownForMin: 20 });
    // r6: Stripe timeout 2h ago; Stripe search has no record → inconclusive + overdue → escalate (NOT marked failed).
    await seed('r6', { status: 'unknown', providerId: 'stripe', ageMin: 120, unknownForMin: 120 });
    // r7/r8/r10: final outcomes, old → never touched.
    await seed('r7', { status: 'success', providerId: 'stripe', ptx: 'pi_r7', ageMin: 180 });
    await seed('r8', { status: 'refunded', providerId: 'stripe', ptx: 'pi_r8', ageMin: 180 });
    await seed('r10', { status: 'failed', providerId: 'stripe', ptx: 'pi_r10', ageMin: 180 });
    // r9: Stripe reports success but for a DIFFERENT amount → escalate, never auto-resolve.
    await seed('r9', { status: 'unknown', providerId: 'stripe', ptx: 'pi_r9', ageMin: 20, unknownForMin: 20 });
    // r11: a LEGACY pre-Phase-6 ambiguous row: 'pending' + a random-UUID "provider id" (D4) → search finds nothing → escalate.
    await seed('r11', { status: 'pending', providerId: 'stripe', ptx: 'f2a4b1c0-0000-4000-8000-00000000d4d4', ageMin: 120 });
    // r12: already escalated, Stripe now confirms success → auto-resolved by the read-only check.
    await seed('r12', { status: 'requires_reconciliation', providerId: 'stripe', ptx: 'pi_r12', ageMin: 180, unknownForMin: 180 });
    // r13: already escalated on a provider with no status query → stays on the operator list, not re-examined.
    await seed('r13', { status: 'requires_reconciliation', providerId: 'nmi', ageMin: 180, unknownForMin: 180 });

    searchResults[ids.r4] = [{ id: 'pi_r4', object: 'payment_intent', status: 'succeeded', amount: 1500, currency: 'usd', metadata: { bisPaymentTransactionId: ids.r4 } }];
    intents.pi_r5 = { id: 'pi_r5', object: 'payment_intent', status: 'requires_action', amount: 1500, currency: 'usd', metadata: { bisPaymentTransactionId: ids.r5 } };
    intents.pi_r9 = { id: 'pi_r9', object: 'payment_intent', status: 'succeeded', amount: 9900, currency: 'usd', metadata: { bisPaymentTransactionId: ids.r9 } };
    intents.pi_r12 = { id: 'pi_r12', object: 'payment_intent', status: 'succeeded', amount: 1500, currency: 'usd', metadata: { bisPaymentTransactionId: ids.r12 } };
  }, 60_000);

  afterAll(async () => {
    while (restores.length) restores.pop()!();
    await client?.end({ timeout: 5 });
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end({ timeout: 5 });
  });

  let report: PaymentReconciliationReport;

  it('the real reconciliation job: resolves what a read-only provider check can prove, escalates the rest, and makes ZERO money-moving provider calls', async () => {
    const emitted: Array<{ decisionReason: string; payload: { payments: PaymentReconciliationReport } }> = [];
    const deps = {
      registry,
      routing: {} as JobDeps['routing'],
      eventBus: { emit: async (e: never) => void emitted.push(e) } as unknown as JobDeps['eventBus'],
      lock: { withLock: async (_k: string, _o: string, _t: number, fn: () => Promise<unknown>) => fn() } as unknown as JobDeps['lock'],
      rateLimiter: {} as JobDeps['rateLimiter'],
      config: createWorkerConfig(), // defaults: stale 15 min, recheck 5 min, escalate 60 min
      keys: {} as JobDeps['keys'],
      paymentReconciliation: repo,
    } as JobDeps;
    const queue = { deadCount: async () => 0 } as never;
    const job = { id: 'recon-1', type: 'reconciliation', payload: {} } as unknown as Job;
    await createReconciliationProcessor(deps, queue)(job, {} as never);

    const completion = emitted.find((e) => e.decisionReason === 'reconciliation_completed');
    expect(completion).toBeDefined();
    report = completion!.payload.payments;

    // ---- the critical safety property --------------------------------------
    expect(moneyCalls).toEqual([]);
    expect(report.chargeAttempts).toBe(0);
    expect(http.every((h) => h.method === 'GET' && h.url.startsWith('https://api.stripe.com/v1/payment_intents'))).toBe(true);
    // One read-only check per examined Stripe row: r4, r5, r6, r9, r11, r12.
    expect(http).toHaveLength(6);
    expect(report.providerStatusChecks).toBe(6);
    expect(report.examined).toBe(8); // + r1, r2 (escalated without any provider contact)
    expect(report.errors).toEqual([]);

    // ---- resolved by the provider's own answer -----------------------------
    expect(await row('r4')).toMatchObject({ status: 'success', ptx: 'pi_r4' });
    expect((await row('r4')).resolution).toMatchObject({ source: 'provider_status_check', providerStatus: 'succeeded' });
    expect(await row('r12')).toMatchObject({ status: 'success', ptx: 'pi_r12' });
    // ---- refined, still watched --------------------------------------------
    expect(await row('r5')).toMatchObject({ status: 'requires_action', ptx: 'pi_r5' });
    // ---- escalated for a human, with what is known -------------------------
    expect((await row('r1')).status).toBe('requires_reconciliation');
    expect((await row('r1')).reason).toMatch(/ambiguous_outcome: provider 'nmi'.*no read-only status query/);
    expect((await row('r2')).status).toBe('requires_reconciliation');
    expect((await row('r2')).reason).toMatch(/^stuck_processing: .*never recorded.*may have been charged/);
    expect((await row('r6')).status).toBe('requires_reconciliation'); // NOT 'failed': "not found" is not proof of no charge
    expect((await row('r6')).reason).toMatch(/not proof that nothing was charged/);
    expect((await row('r9')).status).toBe('requires_reconciliation');
    expect((await row('r9')).reason).toMatch(/^provider_amount_mismatch/);
    expect((await row('r11')).status).toBe('requires_reconciliation');
    // ---- untouched ---------------------------------------------------------
    expect((await row('r3')).status).toBe('processing');
    expect((await row('r3')).checks).toBe(0);
    expect((await row('r7')).status).toBe('success');
    expect((await row('r8')).status).toBe('refunded');
    expect((await row('r10')).status).toBe('failed');
    expect((await row('r13')).status).toBe('requires_reconciliation');
  });

  it('the escalated payments are listed for an operator with full context (amount, provider, timestamps, how long stuck, why)', async () => {
    const list = await repo.listRequiringReconciliation({ appId: 'app_p6r' });
    const listed = new Set(list.map((r) => r.id));
    for (const k of ['r1', 'r2', 'r6', 'r9', 'r11', 'r13']) expect(listed.has(ids[k])).toBe(true);
    for (const k of ['r3', 'r4', 'r5', 'r7', 'r8', 'r10', 'r12']) expect(listed.has(ids[k])).toBe(false);
    const r2 = list.find((r) => r.id === ids.r2)!;
    expect(r2).toMatchObject({ amount: '15.00', currency: 'USD', providerId: 'unassigned', appId: 'app_p6r', tenantId: 'ten_p6r' });
    expect(r2.createdAt).toBeInstanceOf(Date);
    expect(r2.reconciliationRequiredAt).toBeInstanceOf(Date);
    expect(r2.reconciliationReason).toBeTruthy();
    const counts = await repo.countUnresolvedByStatus();
    expect(counts).toMatchObject({ requires_reconciliation: 6, processing: 1, requires_action: 1 });
  });

  it('a second run right away re-queries nothing (recheck window) and still makes zero money-moving calls', async () => {
    const before = http.length;
    const again = await runPaymentReconciliationOnce({ registry }, repo, resolvePaymentReconciliationConfig());
    expect(again.examined).toBe(0);
    expect(http.length).toBe(before);
    expect(moneyCalls).toEqual([]);
  });

  it('the instrumentation is live (control): a direct adapter call IS counted', async () => {
    await registry.getProvider('example-pay')!.processRequest('app_p6r', { amount: 1, currency: 'USD', paymentMethod: 'card' } as never, 'control');
    expect(moneyCalls).toEqual(['example-pay.processRequest']);
  });
});
