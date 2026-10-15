import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 8 — outbound side of the shared-number STOP (gap register A4):
 * RoutingEngine.routeMessage resolves the business number a send goes FROM
 * and refuses to send from a number the recipient STOPped. Data access is
 * stubbed here; the same behaviour is exercised end-to-end on real
 * PostgreSQL in packages/simulation/src/shared-number.scenarios.ts.
 */

const db = vi.hoisted(() => ({
  senderOptedOut: false as boolean | 'throw',
  profiles: [] as Array<{ id: string; appId: string; tenantId: string; supplierId: string | null; sender: string; provider: string; country: string }>,
  senderLookups: 0,
  profileLookups: 0,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consentRecordRepository: { isOptedOut: async () => false },
    messagingProfileRepository: {
      findSendersForOwner: async (appId: string, tenantId: string, provider: string) => {
        db.profileLookups++;
        return db.profiles.filter((p) => p.appId === appId && p.tenantId === tenantId && p.provider === provider);
      },
    },
    senderOptOutRepository: {
      isOptedOut: async () => {
        db.senderLookups++;
        if (db.senderOptedOut === 'throw') throw new Error('connection refused');
        return db.senderOptedOut;
      },
    },
    conversationRepository: {
      findActiveForOwner: async () => [],
      upsert: async (phone: string, appId: string, data: Record<string, unknown>) => {
        db.upserts.push({ phone, appId, ...data });
        return { id: 'c1' };
      },
    },
  };
});

import { RoutingEngine, ConsentBlockedError } from './index';

const SHARED = '+265991000001';

describe('routeMessage — sender (business number) resolution and sender-level STOP', () => {
  beforeEach(() => {
    db.senderOptedOut = false;
    db.senderLookups = 0;
    db.profileLookups = 0;
    db.upserts = [];
    db.profiles = [
      { id: 'p_mw', appId: 'reach', tenantId: 't1', supplierId: null, sender: SHARED, provider: 'signalhouse', country: 'MW' },
      { id: 'p_zm', appId: 'reach', tenantId: 't1', supplierId: null, sender: '+260971000002', provider: 'signalhouse', country: 'ZM' },
    ];
  });

  it('records the conversation on the business number registered for the recipient\'s country', async () => {
    const event = await new RoutingEngine().routeMessage('reach', {
      recipient: '+265881234567', content: 'hi', providerOverride: 'signalhouse', tenantId: 't1',
    });
    expect(event.status).toBe('success');
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({ businessNumber: SHARED, messagingProfileId: 'p_mw', country: 'MW', tenantId: 't1' });
  });

  it('leaves the number unrecorded rather than guessing when the owner has several registrations and the country is unknown', async () => {
    await new RoutingEngine().routeMessage('reach', {
      recipient: '+15005550006', content: 'hi', providerOverride: 'signalhouse', tenantId: 't1',
    });
    expect(db.upserts[0]).toMatchObject({ businessNumber: null });
  });

  it('a recipient who STOPped the shared number is blocked — and the send is NOT cascaded to another provider/number', async () => {
    db.senderOptedOut = true;
    await expect(
      new RoutingEngine().routeMessage('reach', { recipient: '+265881234567', content: 'hi', providerOverride: 'signalhouse', tenantId: 't1' }),
    ).rejects.toBeInstanceOf(ConsentBlockedError);
    expect(db.profileLookups).toBe(1); // exactly one attempt
    expect(db.upserts).toHaveLength(0);
  });

  it('fails CLOSED: a sender-level consent lookup error aborts the send, with no cascade', async () => {
    db.senderOptedOut = 'throw';
    await expect(
      new RoutingEngine().routeMessage('reach', { recipient: '+265881234567', content: 'hi', providerOverride: 'signalhouse', tenantId: 't1' }),
    ).rejects.toMatchObject({ name: 'SenderConsentLookupError' });
    expect(db.senderLookups).toBe(1);
    expect(db.profileLookups).toBe(1);
    expect(db.upserts).toHaveLength(0);
  });

  it('a supplier-dedicated registration wins for that supplier; other suppliers use the tenant-level number', async () => {
    db.profiles = [
      { id: 'p_shared', appId: 'stay', tenantId: 't3', supplierId: null, sender: SHARED, provider: 'signalhouse', country: 'MW' },
      { id: 'p_hotel_a', appId: 'stay', tenantId: 't3', supplierId: 'hotel-a', sender: '+265991000555', provider: 'signalhouse', country: 'MW' },
    ];
    const engine = new RoutingEngine();
    await engine.routeMessage('stay', { recipient: '+265881234567', content: 'a', providerOverride: 'signalhouse', tenantId: 't3', supplierId: 'hotel-a' });
    await engine.routeMessage('stay', { recipient: '+265881234567', content: 'b', providerOverride: 'signalhouse', tenantId: 't3', supplierId: 'hotel-b' });
    expect(db.upserts.map((u) => [u.supplierId, u.businessNumber])).toEqual([
      ['hotel-a', '+265991000555'],
      ['hotel-b', SHARED],
    ]);
  });
});
