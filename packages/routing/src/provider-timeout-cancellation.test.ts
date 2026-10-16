/**
 * Phase 11-12 — gap register E6: the router's timeout must CANCEL the
 * adapter's in-flight request and its internal retry loop.
 *
 * Before: withProviderTimeout() raced processRequest() against an
 * AbortSignal.timeout() that was never handed to the provider; the router
 * reported 'unknown' while BaseProvider.http_request kept retrying (up to 3
 * attempts with backoff) in the background — real charge attempts nobody
 * would read the result of.
 *
 * The HTTP layer is instrumented (a fetch stub recording every call with a
 * timestamp and its AbortSignal), and each test keeps watching for well past
 * the point where the old background retry would have fired.
 *
 * PROVIDER_TIMEOUT_MS is read at module load, so it is set before imports.
 */
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.PROVIDER_TIMEOUT_MS = '300';
});

import { randomUUID } from 'node:crypto';
import { RoutingEngine, PROVIDER_TIMEOUT_MS } from './index';
import { ProviderRegistry, BaseProvider, runWithProviderCallOptions, ProviderCallError } from '@company/providers';
import type { ProviderConfig, TransactionEvent } from '@company/schemas';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call { url: string; at: number; signal?: AbortSignal | null }

/** fetch stub: records calls; `respond` decides each response. */
function instrumentFetch(respond: (call: Call, init?: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), at: Date.now(), signal: init?.signal };
    calls.push(call);
    return respond(call, init);
  }));
  return calls;
}

/** A response that never arrives unless the request is aborted (then rejects like undici). */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
  });
}

describe('Phase 11-12 — the router timeout cancels the adapter request chain (E6)', () => {
  const registry = ProviderRegistry.getInstance();
  const engine = new RoutingEngine();

  afterEach(() => {
    registry.getProvider('stripe')!.setSecrets({});
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the configured short timeout in this file', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(300);
  });

  it('a hung in-flight charge is ABORTED when the router times out, and no retry is ever started afterwards', async () => {
    registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_e6' });
    const calls = instrumentFetch((_c, init) => hangUntilAborted(init));

    const started = Date.now();
    const event = await engine.routePayment('app_e6', {
      amount: 10, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', paymentToken: 'pm_x', paymentTransactionId: randomUUID(),
    });
    const returnedAt = Date.now();

    expect(event.status).toBe('unknown');
    expect(returnedAt - started).toBeLessThan(2_000);
    // Stripe's adapter would retry once after a 500ms backoff (maxAttempts 2,
    // retryAmbiguous) — watch for 3x that long.
    await sleep(1_500);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(true); // the in-flight request itself was cancelled
    expect(calls.filter((c) => c.at >= returnedAt)).toEqual([]);
  });

  it("a pending retry BACKOFF is interrupted: after the router's timeout the adapter's retry loop makes no further HTTP call", async () => {
    registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_e6' });
    // Each attempt answers 503 immediately → Stripe's adapter (idempotent,
    // retryAmbiguous) sleeps 500ms and retries. The router times out at
    // 300ms, i.e. during that backoff.
    const calls = instrumentFetch(async () => json({ error: { type: 'api_error', message: 'unavailable' } }, 503));

    const event = await engine.routePayment('app_e6', {
      amount: 10, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', paymentToken: 'pm_x', paymentTransactionId: randomUUID(),
    });
    const returnedAt = Date.now();
    expect(event.status).toBe('unknown');
    expect(String(event.error)).toContain('timed out');

    await sleep(1_500);
    expect(calls).toHaveLength(1);
    expect(calls.filter((c) => c.at >= returnedAt)).toEqual([]);
  });

  it('control: the SAME adapter and stub, called with no router (no cancellation), DOES retry — so the instrumentation would catch a background retry', async () => {
    registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_e6' });
    const calls = instrumentFetch(async () => json({ error: { type: 'api_error', message: 'unavailable' } }, 503));
    const event = await registry.getProvider('stripe')!.processRequest(
      'app_e6',
      { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_x', paymentTransactionId: randomUUID() } as never,
      'no-router control',
    );
    expect(calls).toHaveLength(2);
    expect(event.status).toBe('unknown');
  });

  it('the generic 3-attempt retry loop (default policy, signal NOT forwarded by the adapter) stops at the first abort', async () => {
    // An adapter that never passes any signal to http_request itself — the
    // cancellation must reach it through the ambient call context the
    // router installs (runWithProviderCallOptions), which is exactly how the
    // real router calls every adapter.
    class NaiveAdapter extends BaseProvider {
      async processRequest(appId: string): Promise<TransactionEvent> {
        const res = await this.http_request({ method: 'POST', url: 'https://naive.example/send', body: { a: 1 }, maxAttempts: 3, timeoutMs: 10_000 });
        return { id: 'n', timestamp: '', appId, category: 'messaging', providerId: 'naive', status: res.status < 400 ? 'success' : 'failed', latency: 0, cost: 0, decisionReason: '', payload: {}, response: null };
      }
    }
    const adapter = new NaiveAdapter({ id: 'naive', name: 'Naive', category: 'messaging', status: 'online', weight: 1, latencyMin: 0, latencyMax: 0 } as unknown as ProviderConfig);
    const calls = instrumentFetch(async () => json({}, 503));

    // Control first: with no cancellation the loop makes all 3 attempts.
    await adapter.processRequest('app');
    expect(calls).toHaveLength(3);
    calls.length = 0;

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('router timeout (test)')), 200);
    const err = await runWithProviderCallOptions({ signal: controller.signal }, () => adapter.processRequest('app')).then(
      () => null,
      (e: unknown) => e,
    );
    const abortedAt = Date.now();
    expect(err).toBeInstanceOf(ProviderCallError);
    expect((err as ProviderCallError).cancelled).toBe(true);
    await sleep(2_000); // the old loop would have retried at ~0.5s and ~1.5s
    expect(calls).toHaveLength(1);
    expect(calls.filter((c) => c.at >= abortedAt)).toEqual([]);
  });

  it('a request is never STARTED under an already-aborted signal (e.g. the second step of a multi-call adapter)', async () => {
    registry.getProvider('stripe')!.setSecrets({ api_key: 'sk_test_e6' });
    const calls = instrumentFetch(async () => json({}, 200));
    const controller = new AbortController();
    controller.abort(new Error('already timed out'));
    const event = await runWithProviderCallOptions({ signal: controller.signal }, () =>
      registry.getProvider('stripe')!.processRequest(
        'app_e6',
        { amount: 10, currency: 'USD', paymentMethod: 'card', paymentToken: 'pm_x', paymentTransactionId: randomUUID() } as never,
        'pre-aborted',
      ),
    );
    expect(calls).toHaveLength(0);
    // Nothing was in flight and nothing was sent → a definite non-charge.
    expect(event.status).toBe('failed');
    expect(String(event.error)).toContain('no attempt was in flight');
  });
});
