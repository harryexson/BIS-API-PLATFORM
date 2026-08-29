import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { conversationRepository } from './conversations';
import { getDb } from '../connection';
import { conversations } from '../schema';

/**
 * Real database integration tests for conversation repository.
 *
 * These tests run against a real PostgreSQL database (Neon).
 * Set DATABASE_URL environment variable to run them.
 * If DATABASE_URL is not set, tests are skipped.
 */

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)('Conversation Repository — Integration Tests', () => {
  let testPhone: string;
  let testAppId: string;
  let testTenantId: string;

  beforeAll(async () => {
    // Generate unique test identifiers
    testPhone = `+1555${Date.now().toString().slice(-7)}`;
    testAppId = `test-app-${Date.now()}`;
    testTenantId = 'default';
  });

  beforeEach(async () => {
    // Clean up test data
    const db = getDb();
    await db
      .delete(conversations)
      .where(
        (c) =>
          c.phoneNumber.startsWith('+1555') ||
          c.appId.startsWith('test-app'),
      );
  });

  afterAll(async () => {
    // Final cleanup
    const db = getDb();
    await db
      .delete(conversations)
      .where(
        (c) =>
          c.phoneNumber.startsWith('+1555') ||
          c.appId.startsWith('test-app'),
      );
  });

  describe('upsert', () => {
    it('creates a new conversation', async () => {
      const result = await conversationRepository.upsert(
        testPhone,
        testAppId,
        {
          providerId: 'test-provider',
          channel: 'sms',
          tenantId: testTenantId,
        },
      );

      expect(result).toBeDefined();
      expect(result.phoneNumber).toBe(testPhone);
      expect(result.appId).toBe(testAppId);
      expect(result.tenantId).toBe(testTenantId);
      expect(result.providerId).toBe('test-provider');
      expect(result.channel).toBe('sms');
      expect(result.status).toBe('active');
    });

    it('updates existing conversation on re-upsert', async () => {
      const first = await conversationRepository.upsert(
        testPhone,
        testAppId,
        {
          providerId: 'provider-v1',
          channel: 'sms',
          tenantId: testTenantId,
        },
      );

      const second = await conversationRepository.upsert(
        testPhone,
        testAppId,
        {
          providerId: 'provider-v2',
          channel: 'whatsapp',
          tenantId: testTenantId,
        },
      );

      expect(second.id).toBe(first.id);
      expect(second.providerId).toBe('provider-v2');
      expect(second.channel).toBe('whatsapp');
    });

    it('creates separate conversations for different tenants', async () => {
      const tenantA = 'tenant-a';
      const tenantB = 'tenant-b';

      const convA = await conversationRepository.upsert(
        testPhone,
        testAppId,
        { providerId: 'p1', channel: 'sms', tenantId: tenantA },
      );

      const convB = await conversationRepository.upsert(
        testPhone,
        testAppId,
        { providerId: 'p2', channel: 'sms', tenantId: tenantB },
      );

      expect(convA.id).not.toBe(convB.id);
      expect(convA.tenantId).toBe(tenantA);
      expect(convB.tenantId).toBe(tenantB);

      // Cleanup
      await conversationRepository.close(testPhone, testAppId, tenantA);
      await conversationRepository.close(testPhone, testAppId, tenantB);
    });
  });

  describe('findByPhoneAndApp', () => {
    it('finds conversation by phone, app, and tenant', async () => {
      await conversationRepository.upsert(testPhone, testAppId, {
        providerId: 'find-provider',
        channel: 'sms',
        tenantId: testTenantId,
      });

      const found = await conversationRepository.findByPhoneAndApp(
        testPhone,
        testAppId,
        testTenantId,
      );

      expect(found).toBeDefined();
      expect(found!.phoneNumber).toBe(testPhone);
      expect(found!.appId).toBe(testAppId);
      expect(found!.tenantId).toBe(testTenantId);
    });

    it('returns undefined for non-existent conversation', async () => {
      const found = await conversationRepository.findByPhoneAndApp(
        '+15550000000',
        'nonexistent-app',
        'default',
      );

      expect(found).toBeUndefined();
    });

    it('does NOT find conversation with wrong tenant (isolation)', async () => {
      await conversationRepository.upsert(testPhone, testAppId, {
        providerId: 'p1',
        channel: 'sms',
        tenantId: 'correct-tenant',
      });

      const found = await conversationRepository.findByPhoneAndApp(
        testPhone,
        testAppId,
        'wrong-tenant',
      );

      expect(found).toBeUndefined();
    });
  });

  describe('findActiveByPhone', () => {
    it('finds all active conversations for a phone number', async () => {
      const phone = `+1555${Date.now().toString().slice(-7)}A`;
      const app1 = `${testAppId}-1`;
      const app2 = `${testAppId}-2`;

      await conversationRepository.upsert(phone, app1, {
        providerId: 'p1',
        channel: 'sms',
        tenantId: testTenantId,
      });
      await conversationRepository.upsert(phone, app2, {
        providerId: 'p2',
        channel: 'whatsapp',
        tenantId: testTenantId,
      });

      const found = await conversationRepository.findActiveByPhone(phone);
      expect(found.length).toBe(2);

      // Cleanup
      await conversationRepository.close(phone, app1, testTenantId);
      await conversationRepository.close(phone, app2, testTenantId);
    });
  });

  describe('close', () => {
    it('closes a conversation', async () => {
      await conversationRepository.upsert(testPhone, testAppId, {
        providerId: 'close-provider',
        channel: 'sms',
        tenantId: testTenantId,
      });

      const closed = await conversationRepository.close(
        testPhone,
        testAppId,
        testTenantId,
      );
      expect(closed).toBe(true);

      const found = await conversationRepository.findByPhoneAndApp(
        testPhone,
        testAppId,
        testTenantId,
      );
      expect(found!.status).toBe('closed');
    });

    it('returns false when closing non-existent conversation', async () => {
      const closed = await conversationRepository.close(
        '+15550000000',
        'nonexistent',
        'default',
      );
      expect(closed).toBe(false);
    });

    it('only closes the specified tenant conversation', async () => {
      const phone = `+1555${Date.now().toString().slice(-7)}B`;
      const app = `${testAppId}-close-multi`;

      await conversationRepository.upsert(phone, app, {
        providerId: 'p1',
        channel: 'sms',
        tenantId: 'tenant-x',
      });
      await conversationRepository.upsert(phone, app, {
        providerId: 'p2',
        channel: 'sms',
        tenantId: 'tenant-y',
      });

      await conversationRepository.close(phone, app, 'tenant-x');

      const convX = await conversationRepository.findByPhoneAndApp(
        phone,
        app,
        'tenant-x',
      );
      const convY = await conversationRepository.findByPhoneAndApp(
        phone,
        app,
        'tenant-y',
      );

      expect(convX!.status).toBe('closed');
      expect(convY!.status).toBe('active');
    });
  });

  describe('count', () => {
    it('returns a count of conversations', async () => {
      const countBefore = await conversationRepository.count();
      expect(countBefore).toBeGreaterThanOrEqual(0);

      await conversationRepository.upsert(testPhone, testAppId, {
        providerId: 'count-provider',
        channel: 'sms',
        tenantId: testTenantId,
      });

      const countAfter = await conversationRepository.count();
      expect(countAfter).toBe(countBefore + 1);
    });
  });
});
