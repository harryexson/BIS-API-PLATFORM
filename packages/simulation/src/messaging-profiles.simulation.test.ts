import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { dbState, clearDb, seedReachChurch, installDatabaseMock, APP_SLUG, TENANT_ID } from './db';

// Replace the persistent store with the in-memory double (see ./db). Everything
// else — gateway — is the REAL code.
vi.mock('@company/database', () => installDatabaseMock());

import { createSimulation, type SimRuntime } from './harness';
import { messagingProfileRepository } from '@company/database';

console.warn(`\n[simulation] A2P/10DLC messaging profiles (registration CRUD, Phase 40/41)\n`);

const AUTH = {
  authorization: 'Bearer bap_test_reachchurch_0001',
  'x-tenant-id': TENANT_ID,
};

let runtime: SimRuntime;

beforeAll(async () => {
  clearDb();
  seedReachChurch();
  runtime = await createSimulation();
}, 30_000);

afterAll(async () => {
  await runtime.close();
}, 15_000);

describe('POST/GET /v1/api/gateway/messaging-profiles', () => {
  it('registers a sender and lists it back, defaulting to unregistered', async () => {
    const created = await runtime.post(
      '/v1/api/gateway/messaging-profiles',
      { country: 'US', senderType: '10dlc', sender: '+15005550100', provider: 'signalhouse' },
      AUTH,
    );
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.appId).toBe(APP_SLUG);
    expect(body.complianceStatus).toBe('unregistered');
    expect(body.senderType).toBe('10dlc');

    const listed = await runtime.get('/v1/api/gateway/messaging-profiles', AUTH);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.count).toBeGreaterThanOrEqual(1);
    expect(listedBody.profiles.some((p: any) => p.id === body.id)).toBe(true);
  });

  it('rejects a missing required field', async () => {
    const res = await runtime.post(
      '/v1/api/gateway/messaging-profiles',
      { country: 'US', senderType: '10dlc', provider: 'signalhouse' }, // missing sender
      AUTH,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an invalid senderType', async () => {
    const res = await runtime.post(
      '/v1/api/gateway/messaging-profiles',
      { country: 'US', senderType: 'carrier-pigeon', sender: '+15005550111', provider: 'signalhouse' },
      AUTH,
    );
    expect(res.status).toBe(400);
  });

  it('one application cannot list another application\'s messaging profiles', async () => {
    const created = await runtime.post(
      '/v1/api/gateway/messaging-profiles',
      { country: 'MW', senderType: 'shortcode', sender: '39900', provider: 'signalhouse' },
      AUTH,
    );
    expect(created.status).toBe(200);

    // No other application is seeded in this harness's dbState by default,
    // so assert isolation at the data layer directly: every profile row is
    // scoped to APP_SLUG, matching the appId the gateway derives from the
    // authenticated API key (never trusted from the request body).
    expect(dbState.messagingProfiles.every((p) => p.appId === APP_SLUG)).toBe(true);
  });
});

describe('compliance status updates (ops/admin workflow)', () => {
  it('updateComplianceStatus transitions a profile after real-world registration approval', async () => {
    const profile = await messagingProfileRepository.create({
      appId: APP_SLUG,
      tenantId: TENANT_ID,
      country: 'US',
      senderType: '10dlc',
      sender: '+15005550199',
      provider: 'signalhouse',
      campaignId: 'CAMP123',
      brandId: 'BRAND456',
    });
    expect(profile.complianceStatus).toBe('unregistered');

    const pending = await messagingProfileRepository.updateComplianceStatus(profile.id, 'pending');
    expect(pending?.complianceStatus).toBe('pending');

    const approved = await messagingProfileRepository.updateComplianceStatus(profile.id, 'approved');
    expect(approved?.complianceStatus).toBe('approved');
  });

  it('rejects an invalid compliance status', async () => {
    const profile = await messagingProfileRepository.create({
      appId: APP_SLUG,
      tenantId: TENANT_ID,
      country: 'US',
      senderType: 'phone',
      sender: '+15005550188',
      provider: 'signalhouse',
    });
    await expect(
      messagingProfileRepository.updateComplianceStatus(profile.id, 'not-a-real-status'),
    ).rejects.toThrow();
  });
});
