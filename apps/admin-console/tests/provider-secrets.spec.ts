import { test, expect, type Page } from '@playwright/test';

// Regression guard for the provider secrets pipeline (packages/providers/
// src/registry.ts's addSecret()/setSecrets() wiring, and the field selector
// this drives in ProviderManagement.tsx's "Add Secret" form). Before this
// pass, a secret entered here never reached the adapter's real HTTP calls —
// see docs/IMPLEMENTATION_CHANGELOG.md's provider-onboarding entry.

const stripeProvider = {
  id: 'stripe', name: 'Stripe', category: 'payment', status: 'online', weight: 70,
  latencyMin: 120, latencyMax: 160, transactionFeePercent: 2.9, transactionFeeFlat: 0.3,
  environment: 'live', countries: ['*'], currencies: ['USD'], capabilities: ['card'],
  priority: 70, health: 'unknown', lastSuccessfulRequest: null, errorRate: 0,
  routingRules: [], configured: false,
};

async function mockBackend(page: Page) {
  await page.route('**/api/dashboard/providers', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([stripeProvider]) })
      : route.continue());
  await page.route('**/api/dashboard/logs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/dashboard/metrics', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ totalRequests: 0, successRate: 100, averageLatency: 0, totalCost: 0, volumePerProvider: {}, volumePerApp: {} }),
  }));
  await page.route('**/api/dashboard/stream', (route) => route.abort());
  await page.route('**/api/dashboard/providers/stripe/secrets', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ id: 'sec_1', field: body.field, label: body.label, masked: 'sk_••••••••••1234' }),
      });
    }
    return route.continue();
  });
}

test.describe('Provider Management — secrets pipeline', () => {
  test('a Not Configured provider offers a field-aware Add Secret form that posts field+label+value', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push('PAGE ERROR: ' + err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('net::ERR_FAILED')) errors.push('CONSOLE: ' + msg.text());
    });

    await mockBackend(page);
    await page.addInitScript(() => localStorage.setItem('bis_admin_token', 'fake-admin-token'));
    await page.goto('/providers');

    // List view shows the Configured column with a "Not Configured" badge
    // for a live provider with no real credentials set.
    await expect(page.getByText('Not Configured')).toBeVisible();

    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible();

    // The field selector is populated from the adapter's known secret
    // fields (packages/providers/src/adapters/payments/stripe.ts reads
    // this.secrets.api_key) rather than a blind free-text box.
    const fieldSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Field…' }) });
    await expect(fieldSelect).toBeVisible();
    const options = await fieldSelect.locator('option').allTextContents();
    expect(options).toContain('api_key — Secret Key');

    await fieldSelect.selectOption('api_key');
    // Choosing a known field auto-fills the label.
    await expect(page.getByPlaceholder('Label (e.g. Live API Key)')).toHaveValue('Secret Key');

    await page.getByPlaceholder('Secret value').fill('sk_live_test_value_123');

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/secrets') && req.method() === 'POST'),
      page.getByRole('button', { name: 'Add', exact: true }).click(),
    ]);
    const postedBody = request.postDataJSON();

    expect(postedBody).toEqual({ field: 'api_key', label: 'Secret Key', value: 'sk_live_test_value_123' });
    expect(errors).toEqual([]);
  });
});
