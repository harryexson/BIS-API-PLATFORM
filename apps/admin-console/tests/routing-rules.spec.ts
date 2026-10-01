import { test, expect, type Page } from '@playwright/test';

// Regression guard for the routing-rule authoring UI (ProviderManagement.tsx's
// "Routing Rules" section) and the RoutingEngine wiring it actually drives
// (packages/routing/src/rules.ts). Before this pass, "Add Rule" always
// POSTed an identical hardcoded template ("currency == USD" -> self) with
// no way to author a real match expression or target, and RoutingEngine
// never consulted this data at all — see docs/IMPLEMENTATION_CHANGELOG.md.

const stripeProvider = {
  id: 'stripe', name: 'Stripe', category: 'payment', status: 'online', weight: 70,
  latencyMin: 120, latencyMax: 160, transactionFeePercent: 2.9, transactionFeeFlat: 0.3,
  environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['card'],
  priority: 70, health: 'unknown', lastSuccessfulRequest: null, errorRate: 0,
  routingRules: [{ id: 'rule_existing', match: 'currency == MWK', target: 'nmi', description: 'route MWK to NMI', enabled: true }],
  configured: true,
};

const nmiProvider = {
  id: 'nmi', name: 'NMI', category: 'payment', status: 'online', weight: 30,
  latencyMin: 140, latencyMax: 190, transactionFeePercent: 2.2, transactionFeeFlat: 0.2,
  environment: 'live', countries: ['US', 'CA'], currencies: ['USD', 'CAD'], capabilities: ['card'],
  priority: 30, health: 'unknown', lastSuccessfulRequest: null, errorRate: 0,
  routingRules: [], configured: true,
};

async function mockBackend(page: Page) {
  await page.route('**/api/dashboard/providers', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([stripeProvider, nmiProvider]) })
      : route.continue());
  await page.route('**/api/dashboard/logs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/dashboard/metrics', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ totalRequests: 0, successRate: 100, averageLatency: 0, totalCost: 0, volumePerProvider: {}, volumePerApp: {} }),
  }));
  await page.route('**/api/dashboard/stream', (route) => route.abort());
  await page.route('**/api/dashboard/providers/*/secrets', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/dashboard/providers/stripe/routing', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ id: 'rule_new', enabled: true, ...body }),
    });
  });
  await page.route('**/api/dashboard/providers/stripe/routing/rule_existing', (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...stripeProvider.routingRules[0], ...body }),
    });
  });
}

test.describe('Provider Management — routing rules authoring', () => {
  test('Add Rule form posts a real match expression, target, and description', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push('PAGE ERROR: ' + err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('net::ERR_FAILED')) errors.push('CONSOLE: ' + msg.text());
    });

    await mockBackend(page);
    await page.addInitScript(() => localStorage.setItem('bis_admin_token', 'fake-admin-token'));
    await page.goto('/providers');

    await page.getByRole('button', { name: 'Manage', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible();

    // The existing rule renders with editable inputs, not just static text.
    await expect(page.getByLabel('Rule match expression')).toHaveValue('currency == MWK');

    // Target select for the new-rule form is populated from every
    // registered provider (not just this one).
    await page.getByPlaceholder('Match expression (e.g. currency == MWK)').fill('amount > 100');
    await page.getByLabel('New rule target provider').selectOption('nmi');
    await page.getByLabel('New rule description').fill('route large payments to NMI');

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/routing') && req.method() === 'POST'),
      page.getByRole('button', { name: 'Add Rule', exact: true }).click(),
    ]);
    const postedBody = request.postDataJSON();

    expect(postedBody).toEqual({
      match: 'amount > 100',
      target: 'nmi',
      description: 'route large payments to NMI',
      enabled: true,
    });
    expect(errors).toEqual([]);
  });

  test('editing an existing rule only shows Save once changed, and PATCHes the edited fields', async ({ page }) => {
    await mockBackend(page);
    await page.addInitScript(() => localStorage.setItem('bis_admin_token', 'fake-admin-token'));
    await page.goto('/providers');
    await page.getByRole('button', { name: 'Manage', exact: true }).first().click();

    const matchInput = page.getByLabel('Rule match expression');
    await expect(matchInput).toHaveValue('currency == MWK');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).not.toBeVisible();

    await matchInput.fill('currency == MWK AND amount > 20');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/routing/rule_existing') && req.method() === 'PATCH'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    const postedBody = request.postDataJSON();
    expect(postedBody.match).toBe('currency == MWK AND amount > 20');
    expect(postedBody.target).toBe('nmi');
  });
});
