import { describe, it, expect } from 'vitest';
import { messagingProfileRepository } from './messaging-profiles';

// create()/updateComplianceStatus() validate senderType/complianceStatus
// before ever calling getDb(), so these are pure unit tests — no
// DATABASE_URL required, unlike the rest of this package's repositories.
describe('messagingProfileRepository — validation (no DB required)', () => {
  it('create() rejects an invalid senderType before touching the database', async () => {
    await expect(
      messagingProfileRepository.create({
        appId: 'app_1',
        tenantId: 'default',
        country: 'US',
        senderType: 'carrier-pigeon',
        sender: '+15005550100',
        provider: 'signalhouse',
      }),
    ).rejects.toThrow('Invalid senderType');
  });

  it('create() rejects an invalid complianceStatus before touching the database', async () => {
    await expect(
      messagingProfileRepository.create({
        appId: 'app_1',
        tenantId: 'default',
        country: 'US',
        senderType: 'phone',
        sender: '+15005550100',
        provider: 'signalhouse',
        complianceStatus: 'not-a-real-status',
      }),
    ).rejects.toThrow('Invalid complianceStatus');
  });

  it('create() accepts every documented senderType (validation does not reject valid input)', async () => {
    const validTypes = ['phone', '10dlc', 'tollfree', 'shortcode', 'alphanumeric'];
    for (const senderType of validTypes) {
      // Each of these gets past validation and only fails on the
      // (expected, since there's no DB here) getDb() call — proves the
      // validation itself doesn't reject valid types.
      await expect(
        messagingProfileRepository.create({
          appId: 'app_1',
          tenantId: 'default',
          country: 'US',
          senderType,
          sender: '+15005550100',
          provider: 'signalhouse',
        }),
      ).rejects.toThrow(/DATABASE_URL/);
    }
  });

  it('updateComplianceStatus() rejects an invalid status before touching the database', async () => {
    await expect(
      messagingProfileRepository.updateComplianceStatus('some-id', 'not-a-real-status'),
    ).rejects.toThrow('Invalid complianceStatus');
  });

  it('updateComplianceStatus() accepts every documented status (validation does not reject valid input)', async () => {
    const validStatuses = ['unregistered', 'pending', 'approved', 'rejected', 'suspended'];
    for (const status of validStatuses) {
      await expect(
        messagingProfileRepository.updateComplianceStatus('some-id', status),
      ).rejects.toThrow(/DATABASE_URL/);
    }
  });
});
