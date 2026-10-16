import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 9 (gap register A13) — the keyword grammar, per-owner matching,
 * per-owner HELP text and configuration validation, without a database.
 * The end-to-end proof (real gateway + worker, in-memory and real
 * PostgreSQL) is packages/simulation/src/keyword-commands.scenarios.ts.
 */

const state = vi.hoisted(() => ({ consent: [] as any[], events: [] as any[] }));

vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    consentRecordRepository: { upsert: async (row: any) => { state.consent.push(row); return row; } },
    eventRepository: { create: async (row: any) => { state.events.push(row); return row; } },
  };
});

import { handleKeyword, matchKeywordCommand, buildHelpResponse, classifyKeyword, type KeywordCommandConfig } from './keywords';
import { validateKeywordCommand, mergeEffectiveKeywordCommands } from '@company/database';

const CHURCH: KeywordCommandConfig[] = [
  { id: 'c1', keyword: 'PRAY', action: 'reply', responseText: 'Prayer received.', helpText: 'send a prayer request' },
  { id: 'c2', keyword: 'CHECK IN', aliases: ['CHECKIN'], action: 'dispatch', workflowId: 'reach.check_in', helpText: 'check in' },
  { id: 'c3', keyword: 'CHECK', action: 'reply', responseText: 'generic check' },
];
const HAULPRO: KeywordCommandConfig[] = [
  { id: 'h1', keyword: 'WHERE IS MY DRIVER', aliases: ['WHERES MY DRIVER'], action: 'dispatch', workflowId: 'haulpro.driver_eta', helpText: 'driver status' },
  { id: 'h2', keyword: 'HELP', action: 'reply', responseText: 'HaulPro: reply STOP to opt out. {commands}' },
  { id: 'h3', keyword: 'STOP', action: 'reply', responseText: 'HaulPro: you will get no more texts. Reply START to rejoin.' },
];

const ctx = (content: string, commands?: KeywordCommandConfig[]) => ({
  senderPhone: '+265880000001', appId: 'app', tenantId: 't1', content, providerId: 'signalhouse', commands,
});

describe('matchKeywordCommand', () => {
  it.each([
    ['CHECK IN', 'CHECK IN', null],
    ['check-in 0930', 'CHECK IN', '0930'],
    ['checkin', 'CHECK IN', null],
    ['Check now', 'CHECK', 'now'],
    ['pray for my mother!', 'PRAY', 'for my mother!'],
    ['PRAY.', 'PRAY', null],
  ])('%s → %s (argument %s) — longest phrase wins', (input, keyword, argument) => {
    const m = matchKeywordCommand(input, CHURCH);
    expect(m?.keyword).toBe(keyword);
    expect(m?.argument).toBe(argument);
  });

  it('only the owner\'s own commands exist: PRAY means nothing to HaulPro, WHERE IS MY DRIVER nothing to a church', () => {
    expect(matchKeywordCommand('PRAY', HAULPRO)).toBeNull();
    expect(matchKeywordCommand('Where is my driver?', CHURCH)).toBeNull();
    expect(matchKeywordCommand('Where is my driver?', HAULPRO)?.keyword).toBe('WHERE IS MY DRIVER');
    expect(matchKeywordCommand('wheres my driver', HAULPRO)?.keyword).toBe('WHERE IS MY DRIVER');
    expect(matchKeywordCommand('Please pray for my mother', CHURCH)).toBeNull();
  });

  it('reserved (wording-override) rows are never matched as commands', () => {
    expect(matchKeywordCommand('STOP', HAULPRO)).toBeNull();
    expect(matchKeywordCommand('HELP', HAULPRO)).toBeNull();
  });
});

describe('buildHelpResponse — no hard-coded church wording', () => {
  it('no configuration → neutral compliance text only', () => {
    expect(buildHelpResponse(undefined)).toBe('Reply STOP to unsubscribe, START to resubscribe, HELP for help.');
    expect(buildHelpResponse([])).not.toMatch(/PRAY|prayer/i);
  });
  it('church → its own commands', () => {
    expect(buildHelpResponse(CHURCH)).toBe(
      'Reply STOP to unsubscribe, START to resubscribe, HELP for help. Commands: PRAY (send a prayer request), CHECK IN (check in).',
    );
  });
  it('logistics → its own wording, its own commands, no prayer', () => {
    expect(buildHelpResponse(HAULPRO)).toBe('HaulPro: reply STOP to opt out. Commands: WHERE IS MY DRIVER (driver status).');
  });
});

describe('handleKeyword with an owner configuration', () => {
  beforeEach(() => {
    state.consent = [];
    state.events = [];
  });

  it('universal keywords win over configuration and keep fixed consent semantics; only wording is the owner\'s', async () => {
    const r = await handleKeyword(ctx('stop', HAULPRO));
    expect(r).toMatchObject({ handled: true, action: 'opt_out', keyword: 'STOP', response: 'HaulPro: you will get no more texts. Reply START to rejoin.' });
    expect(state.consent).toEqual([expect.objectContaining({ status: 'opted_out', tenantId: 't1', appId: 'app' })]);
  });

  it('a configured reply command answers with the owner\'s text and is audited as keyword_command:<KEYWORD>', async () => {
    const r = await handleKeyword({ ...ctx('PRAY', CHURCH), conversationId: 'conv-1', attribution: 'conversation' });
    expect(r).toMatchObject({ handled: true, action: 'command', keyword: 'PRAY', response: 'Prayer received.', command: { mode: 'reply', commandId: 'c1' } });
    expect(state.events[0]).toMatchObject({ decisionReason: 'keyword_command:PRAY', payload: expect.objectContaining({ conversationId: 'conv-1', attribution: 'conversation', tenantId: 't1' }) });
    expect(state.consent).toHaveLength(0);
  });

  it('a dispatch command returns the dispatch descriptor and NO invented answer', async () => {
    const r = await handleKeyword(ctx('Where is my driver?', HAULPRO));
    expect(r).toMatchObject({
      handled: true, action: 'command', keyword: 'WHERE IS MY DRIVER',
      command: { mode: 'dispatch', workflowId: 'haulpro.driver_eta', commandId: 'h1', argument: null },
    });
    expect(r.response).toBeUndefined();
  });

  it('PRAY for an owner that configured nothing is not a keyword at all', async () => {
    expect(await handleKeyword(ctx('PRAY'))).toEqual({ handled: false });
    expect(classifyKeyword('PRAY')).toBeNull();
  });

  it('START reply wording defaults to a neutral text naming STOP', async () => {
    const r = await handleKeyword(ctx('START'));
    expect(r.action).toBe('opt_in');
    expect(r.response).toMatch(/STOP/);
    expect(r.response).not.toMatch(/PRAY|prayer/i);
  });
});

describe('validateKeywordCommand', () => {
  it.each([
    [{ keyword: 'STOP', action: 'dispatch' }, 'action'],
    [{ keyword: 'HELP', action: 'reply', responseText: 'Visit our site' }, 'responseText'],
    [{ keyword: 'STOP', action: 'reply', responseText: 'Bye' }, 'responseText'],
    [{ keyword: 'STOP', action: 'reply', responseText: 'Bye, reply START', enabled: false }, 'enabled'],
    [{ keyword: 'START', action: 'reply', responseText: 'hi', aliases: ['GO'] }, 'aliases'],
    [{ keyword: 'CANCEL ORDER', action: 'dispatch' }, 'keyword'],
    [{ keyword: 'END OF DAY', action: 'dispatch' }, 'keyword'],
    [{ keyword: 'TRACK', action: 'dispatch', aliases: ['UNSUBSCRIBE'] }, 'aliases'],
    [{ keyword: 'PRAY', action: 'reply' }, 'responseText'],
    [{ keyword: 'PRAY', action: 'reply', responseText: 'ok', workflowId: 'x' }, 'workflowId'],
    [{ keyword: 'DRIVER', action: 'dispatch', workflowId: 'bad id!' }, 'workflowId'],
    [{ keyword: 'A;DROP', action: 'dispatch' }, 'keyword'],
    [{ keyword: 'PRAY', action: 'shout' }, 'action'],
  ])('rejects %j (field %s)', (input, field) => {
    expect(() => validateKeywordCommand(input as any)).toThrow(expect.objectContaining({ field }));
  });

  it('canonicalises a valid command', () => {
    expect(validateKeywordCommand({ keyword: ' where is my  driver? ', action: 'dispatch', aliases: ['wheres-my-driver', 'WHERE IS MY DRIVER'], workflowId: 'haulpro.driver_eta' }))
      .toEqual({ keyword: 'WHERE IS MY DRIVER', action: 'dispatch', aliases: ['WHERES MY DRIVER'], responseText: null, helpText: null, workflowId: 'haulpro.driver_eta', enabled: true });
  });

  it('a compliant STOP/HELP wording override is accepted', () => {
    expect(validateKeywordCommand({ keyword: 'help', action: 'reply', responseText: 'Afribook: reply STOP to opt out. {commands}' }).keyword).toBe('HELP');
    expect(validateKeywordCommand({ keyword: 'STOP', action: 'reply', responseText: 'Unsubscribed. Reply START to rejoin.' }).keyword).toBe('STOP');
  });
});

describe('mergeEffectiveKeywordCommands — application defaults overlaid by the tenant', () => {
  const rows = [
    { keyword: 'PRAY', tenantId: null, aliases: [], enabled: true, responseText: 'app' },
    { keyword: 'GIVE', tenantId: null, aliases: [], enabled: true, responseText: 'app' },
    { keyword: 'PRAY', tenantId: 'hope', aliases: [], enabled: true, responseText: 'hope' },
    { keyword: 'GIVE', tenantId: 'hope', aliases: [], enabled: false, responseText: 'hope' },
    { keyword: 'SECRET', tenantId: 'grace', aliases: [], enabled: true, responseText: 'grace only' },
  ];
  it('tenant rows replace app rows keyword by keyword; disabled rows drop out; other tenants never leak in', () => {
    expect(mergeEffectiveKeywordCommands(rows, 'hope').map((r) => [r.keyword, r.responseText])).toEqual([['PRAY', 'hope']]);
    expect(mergeEffectiveKeywordCommands(rows, 'grace').map((r) => [r.keyword, r.responseText])).toEqual([
      ['GIVE', 'app'], ['PRAY', 'app'], ['SECRET', 'grace only'],
    ]);
  });
});

describe('classifyKeyword — universal normalisation', () => {
  it.each([
    ['end-of-day report attached', null], // hyphens are NOT mapped for STOP-word prefix matching
    ['END of the road', 'STOP'], // pre-existing CTIA-style prefix behaviour, unchanged
    ['opt out', 'STOP'],
    ['Stop!', 'STOP'],
  ])('%s → %s', (input, expected) => {
    expect(classifyKeyword(input)).toBe(expected);
  });
});
