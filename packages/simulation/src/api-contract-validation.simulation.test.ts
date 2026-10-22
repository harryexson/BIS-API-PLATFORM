import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, TENANT_ID, API_KEY, APP_SLUG } from './db';

// Phase 17-18 — gap register C10 (presence-only request validation) and F11
// (the published API contract), proven through the REAL gateway routes
// (services/api-gateway/src/app.ts) against the in-memory database double.
// Every rejected request here is refused BEFORE any database write or
// provider call, so there is no real-backend-specific behaviour to cover;
// the admin provider-config validation (which does touch the store) is in
// provider-state.scenarios.ts and runs against real PostgreSQL too.
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

const ADMIN_TOKEN = 'p17-admin-token-sim-0123456789';
const AUTH = {
  'content-type': 'application/json',
  authorization: `Bearer ${API_KEY}`,
  'x-tenant-id': TENANT_ID,
};

let runtime: SimRuntime;
const restores: Array<() => void> = [];

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation({ env: { ADMIN_API_TOKEN: ADMIN_TOKEN } });
}, 30_000);

afterEach(() => {
  while (restores.length) restores.pop()!();
});

afterAll(async () => {
  await runtime?.close();
}, 15_000);

type Adapter = { processRequest: (appId: string, payload: unknown, reason: string) => Promise<unknown> };

/** Records every adapter call of a category (the call still goes through). */
function instrumentAdapters(category: 'payment' | 'messaging') {
  const calls: Array<{ providerId: string; payload: any }> = [];
  for (const cfg of runtime.registry.getAllConfigs().filter((c) => c.category === category)) {
    const adapter = runtime.registry.getProvider(cfg.id) as unknown as Adapter;
    const original = adapter.processRequest;
    adapter.processRequest = async function (appId: string, payload: any, reason: string) {
      calls.push({ providerId: cfg.id, payload });
      return original.call(adapter, appId, payload, reason);
    };
    restores.push(() => {
      adapter.processRequest = original;
    });
  }
  return calls;
}

async function send(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const res = await runtime.request('POST', path, { headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// JSON can't carry NaN/Infinity, so every "number" case below is something a
// real client can actually send.
const INVALID_AMOUNTS: unknown[] = [
  true, // Number(true) === 1 — passed the old `Number(amount) > 0` check and was charged as 1.00
  [5], // Number([5]) === 5 — likewise
  '0x10', // Number('0x10') === 16 — likewise
  '1e3', // Number('1e3') === 1000 — likewise
  49.999999, // sub-cent precision — likewise
  '49.999',
  1e12, // above the sanity bound
  0,
  -5,
  '-5',
  'abc',
  {},
  null,
];

describe('C10 — public payment route: amount is a positive MAJOR-unit amount with at most 2 decimals', () => {
  const pay = (body: Record<string, unknown>) =>
    send('/v1/api/gateway/payment', { amount: 40, currency: 'USD', paymentMethod: 'card', providerOverride: 'stripe', ...body });

  it('rejects every malformed amount / currency with 400 before any transaction row or provider call', async () => {
    const calls = instrumentAdapters('payment');
    const before = dbState.transactions.length;
    for (const amount of INVALID_AMOUNTS) {
      const res = await pay({ amount });
      expect(res.status, `amount ${JSON.stringify(amount)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'amount' });
    }
    const missing = await send('/v1/api/gateway/payment', { currency: 'USD', paymentMethod: 'card' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.field).toBe('amount');
    for (const currency of [5, 'US', 'DOLLARS', ['USD']]) {
      const res = await pay({ currency });
      expect(res.status, `currency ${JSON.stringify(currency)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'currency' });
    }
    expect(calls).toHaveLength(0);
    expect(dbState.transactions.length).toBe(before);
  });

  it('accepts a 2-decimal amount as a number or a decimal string and records it unchanged, in major units', async () => {
    const calls = instrumentAdapters('payment');
    const asNumber = await pay({ amount: 49.99 });
    expect(asNumber.status).toBe(200);
    const asString = await pay({ amount: '12.50' });
    expect(asString.status).toBe(200);
    expect(calls.map((c) => c.payload.amount)).toEqual([49.99, 12.5]);
    expect(dbState.transactions.find((t) => t.id === asNumber.body.paymentTransactionId)?.amount).toBe('49.99');
    expect(dbState.transactions.find((t) => t.id === asString.body.paymentTransactionId)?.amount).toBe('12.5');
  });
});

describe('C10 — checkout session creation validates amount and currency (was only `!amount || !currency`)', () => {
  const create = (body: Record<string, unknown>) => send('/v1/api/gateway/checkout-sessions', { amount: 25, currency: 'USD', ...body });

  it('rejects "-5", non-numeric, zero, sub-cent and absurd amounts, and a missing/malformed currency — no session is created', async () => {
    const before = dbState.checkoutSessions.length;
    for (const amount of INVALID_AMOUNTS) {
      const res = await create({ amount });
      expect(res.status, `amount ${JSON.stringify(amount)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'amount' });
    }
    for (const currency of [undefined, '', 5, 'US']) {
      const res = await create({ currency });
      expect(res.status, `currency ${JSON.stringify(currency)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'currency' });
    }
    expect(dbState.checkoutSessions.length).toBe(before);
  });

  it('creates a session for a valid amount, stored and served back in major units', async () => {
    const res = await create({ amount: '19.99' });
    expect(res.status).toBe(201);
    const row = dbState.checkoutSessions.find((s) => s.token === res.body.token)!;
    expect(row.amount).toBe('19.99');
    const shown = await runtime.get(`/v1/checkout/sessions/${res.body.token}`);
    expect((await shown.json()).amount).toBe(19.99);
  });
});

describe('C10 — messaging route validates recipient and content (was presence-only)', () => {
  const message = (body: Record<string, unknown>) =>
    send('/v1/api/gateway/messaging', { recipient: '+15557000001', content: 'Your appointment is confirmed.', ...body });

  it('rejects malformed recipients and empty/blank/non-string/oversized bodies with 400 — no provider is called', async () => {
    const calls = instrumentAdapters('messaging');
    const badRecipients: unknown[] = [12345, 'not a phone number', 'a@b', '12', ['+15557000001'], '   '];
    for (const recipient of badRecipients) {
      const res = await message({ recipient });
      expect(res.status, `recipient ${JSON.stringify(recipient)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'recipient' });
    }
    const badContent: unknown[] = ['   ', '\n\t', 42, { text: 'hi' }, 'x'.repeat(16_385)];
    for (const content of badContent) {
      const res = await message({ content });
      expect(res.status, `content ${JSON.stringify(content).slice(0, 30)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'content' });
    }
    expect(calls).toHaveLength(0);
  });

  it('still accepts phone numbers (formatted, whatsapp:-scheme) and email addresses', async () => {
    for (const recipient of ['+15557000002', '+1 (555) 700-0003', 'whatsapp:+15557000004', 'member@reachchurch.example']) {
      const res = await message({ recipient });
      expect(res.status, `recipient ${recipient}: ${JSON.stringify(res.body)}`).not.toBe(400);
    }
  });
});

describe('C10 — admin playground payment uses the same money validation', () => {
  it('rejects a sub-cent / boolean amount with 400 before any transaction row', async () => {
    const before = dbState.transactions.length;
    for (const amount of [49.999, true, '0x10']) {
      const res = await send(
        '/api/dashboard/playground/dispatch',
        { category: 'payment', appId: APP_SLUG, tenantId: TENANT_ID, amount, currency: 'USD', paymentMethod: 'card' },
        { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      );
      expect(res.status, `amount ${JSON.stringify(amount)}`).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'invalid_request', field: 'amount' });
    }
    expect(dbState.transactions.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// F11 — docs/openapi.yaml must describe the gateway that actually runs.
// No YAML parser is a dependency of this repo, so the spec is read with a
// line-based reader; the spec keeps the standard 2-space layout this relies
// on (`  /path:` under `paths:`, `    get:` under a path).
// ---------------------------------------------------------------------------
const SPEC_PATH = path.resolve(__dirname, '../../../docs/openapi.yaml');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

interface SpecOperation {
  method: string;
  path: string;
  block: string;
}

function readSpecOperations(spec: string): SpecOperation[] {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => l === 'paths:');
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  const ops: SpecOperation[] = [];
  let path: string | null = null;
  let current: SpecOperation | null = null;
  for (const line of lines.slice(start + 1, end)) {
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) {
      path = p[1];
      current = null;
      continue;
    }
    const m = /^ {4}([a-z]+):\s*$/.exec(line);
    if (m && HTTP_METHODS.includes(m[1]) && path) {
      current = { method: m[1], path, block: '' };
      ops.push(current);
      continue;
    }
    if (/^ {4}\S/.test(line)) current = null; // path-level key (e.g. parameters)
    if (current) current.block += `${line}\n`;
  }
  return ops;
}

/** The schema block `    <name>:` under components.schemas. */
function schemaBlock(spec: string, name: string): string {
  const lines = spec.split('\n');
  const at = lines.findIndex((l) => l === `    ${name}:`);
  if (at < 0) return '';
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^ {0,4}\S/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

interface LiveRoute {
  method: string;
  path: string;
  tenantScoped: boolean;
}

async function liveRouteTable(): Promise<LiveRoute[]> {
  const app = (await import('../../../services/api-gateway/src/app')).default as unknown as {
    _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string }> } }> };
  };
  const routes: LiveRoute[] = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    const tenantScoped = layer.route.stack.some((s) => s.name === 'resolveTenantContext');
    for (const method of Object.keys(layer.route.methods)) routes.push({ method, path: layer.route.path, tenantScoped });
  }
  return routes;
}

const toExpressPath = (p: string) => p.replace(/\{([^}]+)\}/g, ':$1');

describe('F11 — docs/openapi.yaml matches the real route table, fields, headers and amount unit', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');
  const ops = readSpecOperations(spec);

  it('documents only routes that exist, with the real methods and full paths', async () => {
    const live = await liveRouteTable();
    expect(ops.length).toBeGreaterThan(0);
    const missing = ops
      .filter((op) => !live.some((r) => r.method === op.method && r.path === toExpressPath(op.path)))
      .map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(missing).toEqual([]);
  });

  it('documents the core public surface (payments, messaging, status, refunds, providers, checkout, webhooks, health)', () => {
    const documented = ops.map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(documented).toEqual(
      expect.arrayContaining([
        'POST /v1/api/gateway/payment',
        'POST /v1/api/gateway/messaging',
        'GET /v1/api/gateway/transaction/{id}',
        'POST /refunds',
        'GET /v1/api/gateway/providers',
        'POST /v1/api/gateway/checkout-sessions',
        'GET /v1/checkout/sessions/{token}',
        'POST /v1/checkout/sessions/{token}/pay',
        'POST /v1/api/webhooks/{provider}',
        'GET /health',
        'GET /ready',
      ]),
    );
  });

  it('every documented tenant-scoped operation declares the required x-tenant-id header', async () => {
    const live = await liveRouteTable();
    // Guard against a vacuous pass: the walk must actually see the middleware.
    expect(live.find((r) => r.method === 'post' && r.path === '/v1/api/gateway/payment')?.tenantScoped).toBe(true);
    expect(live.find((r) => r.method === 'post' && r.path === '/refunds')?.tenantScoped).toBe(true);
    expect(spec).toMatch(/TenantId:\n\s+name: x-tenant-id\n\s+in: header\n\s+required: true/);
    const undocumented = ops
      .filter((op) => live.find((r) => r.method === op.method && r.path === toExpressPath(op.path))?.tenantScoped)
      .filter((op) => !op.block.includes("$ref: '#/components/parameters/TenantId'"))
      .map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(undocumented).toEqual([]);
  });

  it('documents the field names the gateway actually reads — not the snake_case ones it ignores', () => {
    const payment = schemaBlock(spec, 'PaymentRequest');
    for (const field of ['amount', 'currency', 'paymentMethod', 'providerOverride', 'phoneNumber', 'paymentToken', 'country', 'metadata', 'idempotency_key']) {
      expect(payment, field).toMatch(new RegExp(`^ {8}${field}:`, 'm'));
    }
    const message = schemaBlock(spec, 'MessageRequest');
    for (const field of ['recipient', 'content', 'channel', 'channelPolicy', 'providerOverride']) {
      expect(message, field).toMatch(new RegExp(`^ {8}${field}:`, 'm'));
    }
    // app_id is taken from the API key; the others were never read at all.
    expect(spec).not.toMatch(/^\s+(app_id|payment_method|phone_number|provider_override):/m);
  });

  it('documents amounts in MAJOR currency units, and every example amount is one the gateway accepts as intended', async () => {
    const { parseMoneyAmount } = await import('@company/schemas');
    const money = schemaBlock(spec, 'MoneyAmount');
    expect(money).toMatch(/type: number/);
    expect(money).toMatch(/multipleOf: 0\.01/);
    expect(money).toMatch(/major currency units/i);
    expect(spec).not.toMatch(/amounts are expressed in the smallest currency unit/i);
    // The card example must charge USD 49.99 — the old spec's 4999 would
    // have been charged as USD 4,999.00.
    expect(spec).toMatch(/amount: 49\.99\n\s+currency: USD/);
    const examples = [...spec.matchAll(/^\s+amount: ([^\s{][^\n]*)$/gm)].map((m) => m[1].trim());
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(parseMoneyAmount(Number(example)).ok, `example amount ${example}`).toBe(true);
    }
  });
});
