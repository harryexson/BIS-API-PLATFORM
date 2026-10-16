import { describe, it, expect } from 'vitest';
import { webhookEndpointRepository } from './webhook-endpoints';

// create() validates eventTypes before ever calling getDb(), so this is a
// pure unit test — no DATABASE_URL required, matching
// messaging-profiles.test.ts's approach for the same reason.
describe('webhookEndpointRepository — validation (no DB required)', () => {
  it('create() rejects an invalid event type before touching the database', async () => {
    await expect(
      webhookEndpointRepository.create({
        appId: 'app_1',
        tenantId: 'default',
        url: 'https://example.com/hook',
        eventTypes: ['not-a-real-category'],
      }),
    ).rejects.toThrow('Invalid event type');
  });

  it('create() accepts every documented category plus the wildcard (fails only once it needs to encrypt/persist)', async () => {
    // create() encrypts the generated secret (needs SECRET_ENCRYPTION_KEY)
    // before it ever calls getDb() — deliberately unset here so a valid
    // eventTypes list still fails, just past validation, not because of it.
    delete process.env.SECRET_ENCRYPTION_KEY;
    for (const eventTypes of [['payment'], ['messaging'], ['other'], ['*'], ['payment', 'messaging']]) {
      await expect(
        webhookEndpointRepository.create({
          appId: 'app_1',
          tenantId: 'default',
          url: 'https://example.com/hook',
          eventTypes,
        }),
      ).rejects.toThrow(/SECRET_ENCRYPTION_KEY/);
    }
  });

  it('resolveSecret() decrypts what encryptSecret produced for the same payload shape', async () => {
    process.env.SECRET_ENCRYPTION_KEY = 'unit-test-secret-encryption-key-0000';
    const { encryptSecret } = await import('../crypto');
    const payload = encryptSecret('whsec_roundtrip_test');
    const resolved = webhookEndpointRepository.resolveSecret({
      id: 'wh_1',
      appId: 'app_1',
      tenantId: 'default',
      url: 'https://example.com/hook',
      encryptedSecret: payload.encrypted,
      secretIv: payload.iv,
      secretTag: payload.tag,
      eventTypes: ['*'],
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(resolved).toBe('whsec_roundtrip_test');
  });
});
