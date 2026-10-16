import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 8 — keyword handling details the shared-number work depends on:
 *  - classifyKeyword() labels a message WITHOUT acting on it (used to tag a
 *    quarantined, unattributed STOP/YES/... — handleKeyword is only ever
 *    called once the owner is known);
 *  - gap register A5: a failed STOP/JOIN consent write is no longer
 *    swallowed (the customer used to be told "unsubscribed" while sends
 *    continued); it now throws so the inbound job retries.
 */

const state = vi.hoisted(() => ({ consentFails: false, consentWrites: 0, eventFails: false }));

vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consentRecordRepository: {
      upsert: async () => {
        state.consentWrites++;
        if (state.consentFails) throw new Error('db down');
        return {};
      },
    },
    eventRepository: {
      create: async () => {
        if (state.eventFails) throw new Error('db down');
        return {};
      },
    },
  };
});

import { classifyKeyword, handleKeyword } from './keywords';

const ctx = (content: string) => ({ senderPhone: '+265880000001', appId: 'reach', tenantId: 't1', content, providerId: 'signalhouse' });

describe('classifyKeyword', () => {
  it.each([
    ['STOP', 'STOP'], ['stop please', 'STOP'], ['UNSUBSCRIBE', 'STOP'], ['Yes', 'YES'], ['n', 'NO'],
    ['HELP', 'HELP'], ['START', 'JOIN'], ['Please pray for my mother', null], ['', null],
    // Phase 9 (gap register A13): PRAY is no longer a PLATFORM keyword — it
    // used to be hard-coded here (with church wording) for every tenant. It
    // now exists only for owners that configure it (keyword_commands), so
    // classifyKeyword — which must work without knowing the owner — no
    // longer labels it. Covered positively in keyword-commands.test.ts.
    ['pray', null],
    // Phase 9: trailing punctuation / extra whitespace no longer defeats a
    // compliance keyword.
    ['Stop.', 'STOP'], ['  stop  ', 'STOP'], ['STOPALL', 'STOP'], ['yes!', 'YES'], ['?', 'HELP'], ['UNSTOP', 'JOIN'],
  ])('%s → %s', (input, expected) => {
    expect(classifyKeyword(input)).toBe(expected);
  });
});

describe('handleKeyword consent writes are not best-effort (gap register A5)', () => {
  beforeEach(() => {
    state.consentFails = false;
    state.eventFails = false;
    state.consentWrites = 0;
  });

  it('STOP: a failed consent write throws instead of reporting "unsubscribed"', async () => {
    state.consentFails = true;
    await expect(handleKeyword(ctx('STOP'))).rejects.toThrow('db down');
  });

  it('JOIN: a failed consent write throws', async () => {
    state.consentFails = true;
    await expect(handleKeyword(ctx('JOIN'))).rejects.toThrow('db down');
  });

  it('the audit-event write stays best-effort once consent is recorded', async () => {
    state.eventFails = true;
    await expect(handleKeyword(ctx('STOP'))).resolves.toMatchObject({ handled: true, action: 'opt_out' });
    expect(state.consentWrites).toBe(1);
  });
});
