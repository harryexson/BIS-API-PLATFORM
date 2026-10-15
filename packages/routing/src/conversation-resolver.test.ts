import { describe, it, expect } from 'vitest';
import {
  ConversationResolver,
  type ConversationResolution,
  type ConversationResolverDeps,
} from './conversation-resolver';
import { countryForE164 } from './index';

/**
 * Phase 8 — ConversationResolver unit tests (no database: injected fakes).
 * The end-to-end proofs through the real gateway + worker + repositories
 * (in-memory double and real PostgreSQL) are in
 * packages/simulation/src/shared-number.scenarios.ts.
 */

type Row = Awaited<ReturnType<ConversationResolverDeps['conversations']['findActiveByPhone']>>[number];
type Profile = Awaited<ReturnType<ConversationResolverDeps['profiles']['findOwnersOfSender']>>[number] & {
  sender: string;
  provider: string;
};

const SHARED = '+265991000001';
const OTHER = '+260971000002';
const DEDICATED = '+265991000099';
const CUSTOMER = '+265881234567';

function fakes(rows: Row[], profiles: Profile[]) {
  const upserts: Array<{ phone: string; appId: string; data: Record<string, unknown> }> = [];
  const deps: ConversationResolverDeps = {
    conversations: {
      async findActiveByPhone(phone) {
        return rows.filter((r) => r.phoneNumber === phone);
      },
      async upsert(phone, appId, data) {
        upserts.push({ phone, appId, data });
        const row: Row = {
          id: `new_${upserts.length}`,
          phoneNumber: phone,
          appId,
          tenantId: data.tenantId,
          supplierId: data.supplierId ?? null,
          businessNumber: data.businessNumber ?? null,
          providerId: data.providerId,
          channel: data.channel,
        };
        rows.push(row);
        return row;
      },
    },
    profiles: {
      async findOwnersOfSender(sender, provider) {
        return profiles.filter((p) => p.sender === sender && p.provider === provider);
      },
    },
  };
  return { deps, upserts };
}

function conv(id: string, appId: string, tenantId: string, opts: Partial<Row> = {}): Row {
  return {
    id,
    phoneNumber: CUSTOMER,
    appId,
    tenantId,
    supplierId: null,
    businessNumber: SHARED,
    providerId: 'signalhouse',
    channel: 'sms',
    lastMessageAt: new Date('2026-01-01T00:00:00Z'),
    ...opts,
  };
}

function profile(id: string, appId: string, tenantId: string, sender: string, opts: Partial<Profile> = {}): Profile {
  return { id, appId, tenantId, supplierId: null, country: 'MW', sender, provider: 'signalhouse', ...opts };
}

const NEWER = new Date('2026-06-01T00:00:00Z');
const OLDER = new Date('2026-01-01T00:00:00Z');

describe('ConversationResolver (Phase 8 — shared phone numbers)', () => {
  it('routes by the destination number, not recency: the newer conversation on ANOTHER number is not a candidate', async () => {
    const { deps } = fakes(
      [
        conv('c_reach', 'reach-church', 't_reach', { businessNumber: SHARED, lastMessageAt: OLDER }),
        conv('c_haul', 'haulpro', 't_haul', { businessNumber: OTHER, lastMessageAt: NEWER }),
      ],
      [profile('p1', 'reach-church', 't_reach', SHARED), profile('p2', 'haulpro', 't_haul', SHARED), profile('p3', 'haulpro', 't_haul', OTHER)],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    expect(r.kind).toBe('routed');
    if (r.kind !== 'routed') return;
    expect(r.owner).toEqual({ appId: 'reach-church', tenantId: 't_reach', supplierId: null });
    expect(r.conversation.id).toBe('c_reach');
    expect(r.sharedNumber).toBe(true);
  });

  it('a pre-Phase-8 conversation (no recorded number) only counts for an owner registered on the destination', async () => {
    const { deps } = fakes(
      [
        conv('c_reach', 'reach-church', 't_reach', { businessNumber: null, lastMessageAt: OLDER }),
        conv('c_haul', 'haulpro', 't_haul', { businessNumber: null, lastMessageAt: NEWER }),
      ],
      [profile('p1', 'reach-church', 't_reach', DEDICATED)],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: DEDICATED });
    expect(r.kind).toBe('routed');
    if (r.kind === 'routed') expect(r.owner.appId).toBe('reach-church');
  });

  it('two owners with conversations on the same shared number → ambiguous, with NO conversation/owner to act on', async () => {
    const { deps } = fakes(
      [
        conv('c_reach', 'reach-church', 't_reach', { lastMessageAt: OLDER }),
        conv('c_haul', 'haulpro', 't_haul', { lastMessageAt: NEWER }),
      ],
      [profile('p1', 'reach-church', 't_reach', SHARED), profile('p2', 'haulpro', 't_haul', SHARED)],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    expect(r.kind).toBe('ambiguous');
    expect(r).not.toHaveProperty('conversation');
    expect(r).not.toHaveProperty('owner');
    if (r.kind !== 'ambiguous') return;
    // Candidate order is deterministic (by owner key), never "most recent first".
    expect(r.candidates.map((c) => c.appId)).toEqual(['haulpro', 'reach-church']);
    expect(r.candidates.map((c) => c.conversationId).sort()).toEqual(['c_haul', 'c_reach']);
  });

  it('ambiguity does not depend on which conversation is newer (swapping recency gives the same answer)', async () => {
    const results: ConversationResolution[] = [];
    for (const [a, b] of [[OLDER, NEWER], [NEWER, OLDER]]) {
      const { deps } = fakes(
        [conv('c_reach', 'reach-church', 't_reach', { lastMessageAt: a }), conv('c_haul', 'haulpro', 't_haul', { lastMessageAt: b })],
        [profile('p1', 'reach-church', 't_reach', SHARED), profile('p2', 'haulpro', 't_haul', SHARED)],
      );
      results.push(await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED }));
    }
    expect(results[0]).toEqual(results[1]);
  });

  it('two suppliers (hotels) of ONE tenant on one shared number are two owners → ambiguous', async () => {
    const { deps } = fakes(
      [
        conv('c_a', 'stayscape', 't_stay', { supplierId: 'hotel-a', lastMessageAt: OLDER }),
        conv('c_b', 'stayscape', 't_stay', { supplierId: 'hotel-b', lastMessageAt: NEWER }),
      ],
      [profile('p1', 'stayscape', 't_stay', SHARED)],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.supplierId)).toEqual(['hotel-a', 'hotel-b']);
  });

  it('a supplier-dedicated number narrows to that supplier', async () => {
    const { deps } = fakes(
      [
        conv('c_a', 'stayscape', 't_stay', { supplierId: 'hotel-a', businessNumber: null }),
        conv('c_b', 'stayscape', 't_stay', { supplierId: 'hotel-b', businessNumber: null, lastMessageAt: NEWER }),
      ],
      [profile('p1', 'stayscape', 't_stay', DEDICATED, { supplierId: 'hotel-a' })],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: DEDICATED });
    expect(r.kind).toBe('routed');
    if (r.kind === 'routed') expect(r.owner.supplierId).toBe('hotel-a');
  });

  it('one owner, several of its own threads: routes to that owner (prefers the thread on this exact number)', async () => {
    const { deps } = fakes(
      [
        conv('legacy', 'reach-church', 't_reach', { businessNumber: null, lastMessageAt: NEWER }),
        conv('exact', 'reach-church', 't_reach', { businessNumber: SHARED, lastMessageAt: OLDER }),
      ],
      [profile('p1', 'reach-church', 't_reach', SHARED), profile('p2', 'haulpro', 't_haul', SHARED)],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    expect(r.kind).toBe('routed');
    if (r.kind === 'routed') expect(r.conversation.id).toBe('exact');
  });

  it('first inbound on a number registered to exactly one owner opens a conversation for that owner', async () => {
    const { deps, upserts } = fakes([], [profile('p1', 'reach-church', 't_reach', DEDICATED, { country: 'MW' })]);
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: DEDICATED });
    expect(r.kind).toBe('routed');
    if (r.kind !== 'routed') return;
    expect(r.created).toBe(true);
    expect(r.basis).toBe('destination_profile');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].data).toMatchObject({ tenantId: 't_reach', businessNumber: DEDICATED, messagingProfileId: 'p1', country: 'MW' });
  });

  it('first inbound on a SHARED number with no conversation → ambiguous over the registered owners (nothing created)', async () => {
    const { deps, upserts } = fakes([], [profile('p1', 'reach-church', 't_reach', SHARED), profile('p2', 'haulpro', 't_haul', SHARED)]);
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.every((c) => c.conversationId === null)).toBe(true);
    expect(upserts).toHaveLength(0);
  });

  it('no owner and no conversation → unroutable', async () => {
    const { deps } = fakes([], []);
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    expect(r.kind).toBe('unroutable');
  });

  it('a provider failover no longer orphans a conversation recorded on the destination number (gap register A3.5)', async () => {
    const { deps } = fakes(
      [conv('c_reach', 'reach-church', 't_reach', { businessNumber: DEDICATED, providerId: 'infobip' })],
      [],
    );
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: DEDICATED });
    expect(r.kind).toBe('routed');
  });

  it('normalises addresses: formatted / whatsapp:-prefixed numbers match the canonical stored form', async () => {
    const { deps } = fakes([conv('c_reach', 'reach-church', 't_reach')], [profile('p1', 'reach-church', 't_reach', SHARED)]);
    const r = await new ConversationResolver(deps).resolve({
      senderPhone: 'whatsapp:+265 88-123 4567',
      providerId: 'signalhouse',
      recipientPhone: '+265 (991) 000-001',
    });
    expect(r.kind).toBe('routed');
  });

  it('legacy no-destination webhooks keep working for the single-tenant case (provider match), but never guess between tenants', async () => {
    const single = fakes([conv('c_reach', 'reach-church', 't_reach', { businessNumber: null })], []);
    expect((await new ConversationResolver(single.deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse' })).kind).toBe('routed');
    const two = fakes(
      [conv('c_reach', 'reach-church', 't_reach', { businessNumber: null }), conv('c_haul', 'haulpro', 't_haul', { businessNumber: null, lastMessageAt: NEWER })],
      [],
    );
    expect((await new ConversationResolver(two.deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse' })).kind).toBe('ambiguous');
  });

  it('type-level: an ambiguous result exposes no conversation/owner without narrowing on `kind`', async () => {
    const { deps } = fakes([], []);
    const r = await new ConversationResolver(deps).resolve({ senderPhone: CUSTOMER, providerId: 'signalhouse', recipientPhone: SHARED });
    // These lines are checked by `npx tsc --noEmit` (the test files are in
    // the root tsconfig): if the union ever regained a conversation/owner
    // readable without narrowing, the @ts-expect-error would itself fail.
    // @ts-expect-error — `conversation` does not exist on the un-narrowed union
    void r.conversation;
    // @ts-expect-error — `owner` does not exist on the un-narrowed union
    void r.owner;
    if (r.kind === 'ambiguous') {
      // @ts-expect-error — and certainly not on the ambiguous variant
      void r.conversation;
    }
    expect(true).toBe(true);
  });
});

describe('countryForE164 (outbound per-country sender tie-break)', () => {
  it('maps single-country calling codes and leaves shared ones undetermined', () => {
    expect(countryForE164('+265991000001')).toBe('MW');
    expect(countryForE164('+260 97 100 0002')).toBe('ZM');
    expect(countryForE164('+27821234567')).toBe('ZA');
    expect(countryForE164('+15005550006')).toBeUndefined();
    expect(countryForE164('39900')).toBeUndefined();
  });
});
