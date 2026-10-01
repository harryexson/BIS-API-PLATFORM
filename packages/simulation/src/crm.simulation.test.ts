import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { clearDb, seedPlans, installDatabaseMock } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — the real gateway, including the new CRM routes — is the REAL code
// (services/api-gateway/src/app.ts).
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';

console.warn(`\n[simulation] Developer CRM / support back office (admin-gated)\n`);

const ADMIN_TOKEN = 'sim-admin-token';

let runtime: SimRuntime;

beforeAll(async () => {
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

beforeEach(() => {
  clearDb();
  seedPlans();
});

const ADMIN = { 'x-admin-token': ADMIN_TOKEN };

async function signupApplication(overrides: Record<string, unknown> = {}) {
  const res = await runtime.post('/v1/api/auth/signup', {
    email: 'owner@reachchurch.example',
    password: 'correct-horse-battery-staple',
    applicationName: 'Reach Church',
    applicationSlug: 'reach-church',
    ...overrides,
  });
  return (await res.json()).application.id as string;
}

describe('GET /api/dashboard/customers', () => {
  it('requires admin auth', async () => {
    const res = await runtime.get('/api/dashboard/customers');
    expect(res.status).toBe(403);
  });

  it('lists signed-up applications as customers', async () => {
    await signupApplication();
    const res = await runtime.get('/api/dashboard/customers', ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customers.some((c: any) => c.application.slug === 'reach-church')).toBe(true);
  });
});

describe('GET /api/dashboard/customers/:id', () => {
  it('404s for an unknown customer', async () => {
    const res = await runtime.get('/api/dashboard/customers/does-not-exist', ADMIN);
    expect(res.status).toBe(404);
  });

  it('returns full detail including users, notes, and tickets — never a password hash', async () => {
    const applicationId = await signupApplication();
    const res = await runtime.get(`/api/dashboard/customers/${applicationId}`, ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.application.slug).toBe('reach-church');
    expect(body.users).toHaveLength(1);
    expect(body.users[0].email).toBe('owner@reachchurch.example');
    expect(body.users[0].passwordHash).toBeUndefined();
    expect(body.notes).toEqual([]);
    expect(body.tickets).toEqual([]);
  });
});

describe('customer notes', () => {
  it('adds a note and it shows up in the customer detail', async () => {
    const applicationId = await signupApplication();
    const addRes = await runtime.post(
      `/api/dashboard/customers/${applicationId}/notes`,
      { authorName: 'Support Rep', body: 'Reached out about onboarding.' },
      ADMIN,
    );
    expect(addRes.status).toBe(201);

    const detail = await (await runtime.get(`/api/dashboard/customers/${applicationId}`, ADMIN)).json();
    expect(detail.notes).toHaveLength(1);
    expect(detail.notes[0].body).toBe('Reached out about onboarding.');
  });

  it('rejects an empty note body with 400', async () => {
    const applicationId = await signupApplication();
    const res = await runtime.post(`/api/dashboard/customers/${applicationId}/notes`, { body: '' }, ADMIN);
    expect(res.status).toBe(400);
  });
});

describe('support tickets', () => {
  it('creates a ticket for a customer and lists it globally', async () => {
    const applicationId = await signupApplication();
    const createRes = await runtime.post(
      `/api/dashboard/customers/${applicationId}/tickets`,
      { subject: 'SMS not sending', description: 'Getting 500 errors since this morning.', priority: 'high' },
      ADMIN,
    );
    expect(createRes.status).toBe(201);
    const ticket = await createRes.json();
    expect(ticket.status).toBe('open');
    expect(ticket.priority).toBe('high');

    const listRes = await runtime.get('/api/dashboard/tickets', ADMIN);
    const listBody = await listRes.json();
    expect(listBody.tickets.some((t: any) => t.id === ticket.id)).toBe(true);
  });

  it('updates a ticket status to resolved and sets resolvedAt', async () => {
    const applicationId = await signupApplication();
    const ticket = await (
      await runtime.post(
        `/api/dashboard/customers/${applicationId}/tickets`,
        { subject: 'x', description: 'y' },
        ADMIN,
      )
    ).json();

    const patchRes = await runtime.request('PATCH', `/api/dashboard/tickets/${ticket.id}`, {
      headers: { 'content-type': 'application/json', ...ADMIN },
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.status).toBe('resolved');
    expect(updated.resolvedAt).toBeTruthy();
  });

  it('adds a comment to a ticket and reads it back via GET /tickets/:id', async () => {
    const applicationId = await signupApplication();
    const ticket = await (
      await runtime.post(
        `/api/dashboard/customers/${applicationId}/tickets`,
        { subject: 'x', description: 'y' },
        ADMIN,
      )
    ).json();

    const commentRes = await runtime.post(
      `/api/dashboard/tickets/${ticket.id}/comments`,
      { authorName: 'Support Rep', body: 'Looking into this now.' },
      ADMIN,
    );
    expect(commentRes.status).toBe(201);

    const getRes = await runtime.get(`/api/dashboard/tickets/${ticket.id}`, ADMIN);
    const body = await getRes.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].body).toBe('Looking into this now.');
  });

  it('reflects an open ticket in the customer list summary', async () => {
    const applicationId = await signupApplication();
    await runtime.post(
      `/api/dashboard/customers/${applicationId}/tickets`,
      { subject: 'x', description: 'y' },
      ADMIN,
    );

    const listRes = await runtime.get('/api/dashboard/customers', ADMIN);
    const body = await listRes.json();
    const reachChurch = body.customers.find((c: any) => c.application.slug === 'reach-church');
    expect(reachChurch.openTicketCount).toBe(1);
  });

  it('rejects ticket creation without required fields with 400', async () => {
    const applicationId = await signupApplication();
    const res = await runtime.post(`/api/dashboard/customers/${applicationId}/tickets`, {}, ADMIN);
    expect(res.status).toBe(400);
  });
});
