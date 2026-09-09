import { test, expect, type Page } from '@playwright/test';

// End-to-end smoke test for the admin console — boots the real Vite dev
// server (see playwright.config.ts's webServer) and mocks every backend
// endpoint it calls, since this environment cannot reach a live database
// (see docs/IMPLEMENTATION_BASELINE.md). Verifies each tab renders real
// data with zero console/page errors — the same check performed manually
// during the 2026-09-09 Customers-tab work, now a permanent regression
// guard instead of a one-off.

const providers = [
  {
    id: 'stripe', name: 'Stripe', category: 'payment', status: 'online', weight: 70,
    latencyMin: 120, latencyMax: 160, transactionFeePercent: 2.9, transactionFeeFlat: 0.3,
    environment: 'live', countries: ['*'], currencies: ['USD', 'EUR'], capabilities: ['card'],
    priority: 70, health: 'healthy', lastSuccessfulRequest: new Date().toISOString(), errorRate: 0,
    routingRules: [],
  },
  {
    id: 'infobip', name: 'Infobip', category: 'messaging', status: 'online', weight: 50,
    latencyMin: 90, latencyMax: 140, messageCost: 0.008,
    environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['sms', 'whatsapp'],
    priority: 50, health: 'healthy', lastSuccessfulRequest: new Date().toISOString(), errorRate: 0,
    routingRules: [],
  },
];

const logs = [
  {
    id: 'evt_1', timestamp: new Date().toISOString(), appId: 'reach-church', category: 'payment',
    providerId: 'stripe', status: 'success', amount: 49.99, currency: 'USD', latency: 145, cost: 1.75,
    decisionReason: 'Weighted routing', payload: {}, response: {},
  },
];

const metrics = {
  totalRequests: 42, successRate: 97.6, averageLatency: 132, totalCost: 12.34,
  volumePerProvider: { stripe: 20, infobip: 22 }, volumePerApp: { 'reach-church': 42 },
};

const obsMetrics = {
  counters: { apiErrors: 1, paymentSuccess: 20, paymentFailure: 0, messageSuccess: 22, messageFailure: 1, providerHealth: 0, webhookFailures: 0, queueFailures: 0, routingFailures: 0 },
  latency: { count: 42, sum: 5544, avg: 132, min: 40, max: 300, p50: 120, p95: 250, p99: 290 },
  providerHealth: { stripe: 'healthy', infobip: 'healthy' },
};
const obsLogs = [
  { timestamp: new Date().toISOString(), level: 'info', message: 'gateway operation completed', operation: 'POST /v1/api/gateway/payment', status: 200, latency: 145 },
];

const customersList = {
  customers: [
    {
      application: { id: 'app_1', name: 'Reach Church', slug: 'reach-church', status: 'active', environment: 'live', createdAt: new Date().toISOString() },
      subscription: { id: 'sub_1', status: 'active', planId: 'plan_growth', currentPeriodEnd: new Date(Date.now() + 2592000000).toISOString(), cancelAtPeriodEnd: false },
      plan: { id: 'plan_growth', slug: 'growth', name: 'Growth' },
      userCount: 2, openTicketCount: 1,
    },
  ],
};
const customerDetail = {
  ...customersList.customers[0],
  users: [{ id: 'u1', email: 'owner@reachchurch.example', name: 'Jane Owner', lastLoginAt: new Date().toISOString(), emailVerifiedAt: new Date().toISOString() }],
  notes: [{ id: 'n1', authorName: 'Support Rep', body: 'Onboarded successfully.', createdAt: new Date().toISOString() }],
  tickets: [{ id: 't1', subject: 'SMS not sending', description: 'Errors since this morning.', status: 'open', priority: 'high', requesterEmail: null, createdAt: new Date().toISOString(), resolvedAt: null }],
};

async function mockBackend(page: Page) {
  await page.route('**/api/dashboard/providers', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(providers) })
      : route.continue(),
  );
  await page.route('**/api/dashboard/logs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(logs) }),
  );
  await page.route('**/api/dashboard/metrics', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metrics) }),
  );
  await page.route('**/api/dashboard/stream', (route) => route.abort());
  await page.route('**/api/observability/metrics', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obsMetrics) }),
  );
  await page.route('**/api/observability/logs', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obsLogs) }),
  );
  await page.route('**/api/dashboard/customers/app_1', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(customerDetail) }),
  );
  await page.route('**/api/dashboard/customers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(customersList) }),
  );
}

async function loginAsAdmin(page: Page) {
  // Seed localStorage before the page's own scripts run, via a single
  // navigation — not goto() + reload(), which cancels the first load's
  // in-flight fetches mid-navigation and surfaces as spurious "Failed to
  // fetch" console errors unrelated to the app itself.
  await page.addInitScript(() => localStorage.setItem('bis_admin_token', 'fake-admin-token'));
  await page.goto('/');
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push('PAGE ERROR: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('net::ERR_FAILED')) {
      // net::ERR_FAILED is expected from the aborted SSE stream route above.
      errors.push('CONSOLE: ' + msg.text());
    }
  });
  return errors;
}

test.describe('Admin console — all tabs render with real data and no errors', () => {
  test('Operations Dashboard renders metrics, topology, playground, logs, and registry', async ({ page }) => {
    const errors = trackErrors(page);
    await mockBackend(page);
    await loginAsAdmin(page);

    await expect(page.getByText('Total Gateway Traffic')).toBeVisible();
    await expect(page.getByText('97.60%')).toBeVisible();
    await expect(page.getByText('Live Routing Network Topology')).toBeVisible();
    await expect(page.getByText('Interactive Request Playground')).toBeVisible();
    await expect(page.getByText('Gateway Transaction Logs')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Provider Management lists providers with health/latency', async ({ page }) => {
    const errors = trackErrors(page);
    await mockBackend(page);
    await loginAsAdmin(page);

    await page.getByRole('button', { name: 'Provider Management' }).click();
    await expect(page.getByText('Stripe', { exact: true })).toBeVisible();
    await expect(page.getByText('Infobip', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manage' }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Customers tab lists customers and drills into detail with notes/tickets', async ({ page }) => {
    const errors = trackErrors(page);
    await mockBackend(page);
    await loginAsAdmin(page);

    await page.getByRole('button', { name: 'Customers' }).click();
    await expect(page.getByText('Reach Church')).toBeVisible();
    await expect(page.getByText('GROWTH')).toBeVisible();

    await page.getByText('Reach Church').click();
    await expect(page.getByText('owner@reachchurch.example')).toBeVisible();
    await expect(page.getByText('Onboarded successfully.')).toBeVisible();
    await expect(page.getByText('SMS not sending')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Customers tab shows an admin-required gate when not logged in', async ({ page }) => {
    const errors = trackErrors(page);
    await mockBackend(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Customers' }).click();
    await expect(page.getByText('Administrator login is required')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Observability tab renders counters, latency percentiles, and provider health', async ({ page }) => {
    const errors = trackErrors(page);
    await mockBackend(page);
    await loginAsAdmin(page);

    await page.getByRole('button', { name: 'Observability' }).click();
    await expect(page.getByText('API Errors')).toBeVisible();
    await expect(page.getByText('132', { exact: true })).toBeVisible();
    await expect(page.getByText('stripe')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('switching between all four tabs in sequence never throws', async ({ page }) => {
    const errors = trackErrors(page);
    await mockBackend(page);
    await loginAsAdmin(page);

    for (const label of ['Provider Management', 'Customers', 'Observability', 'Operations Dashboard']) {
      await page.getByRole('button', { name: label }).click();
      await page.waitForTimeout(150);
    }
    expect(errors).toEqual([]);
  });
});
