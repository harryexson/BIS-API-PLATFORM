/**
 * Phase 9 (gap register A13) — the DB-free keyword grammar shared by the
 * inbound keyword pipeline (@company/routing), the keyword_commands
 * repository's validation, and the simulation's database double (which
 * imports this file relatively, like messaging-address.ts).
 *
 * Two kinds of keyword exist:
 *  - UNIVERSAL: STOP / START (+ synonyms), HELP (+ synonyms) and YES / NO.
 *    Recognised for every owner, with fixed consent semantics. They are
 *    matched FIRST, so no tenant-configured command can ever shadow them —
 *    and the repository refuses to store a command that a universal pattern
 *    would swallow (e.g. "CANCEL BOOKING" is a STOP under CTIA conventions).
 *  - CONFIGURED: everything else, per application / tenant (keyword_commands).
 */

export type UniversalKeywordClass = 'STOP' | 'HELP' | 'YES' | 'NO' | 'JOIN';

/** Reserved names a keyword_commands row may use to override reply wording. */
export const RESERVED_KEYWORD_NAMES = ['STOP', 'START', 'HELP', 'YES', 'NO'] as const;
export type ReservedKeywordName = (typeof RESERVED_KEYWORD_NAMES)[number];

/** The universal class a reserved keyword_commands row overrides the wording of. */
export const RESERVED_TO_CLASS: Record<ReservedKeywordName, UniversalKeywordClass> = {
  STOP: 'STOP',
  START: 'JOIN',
  HELP: 'HELP',
  YES: 'YES',
  NO: 'NO',
};

const STOP_PATTERNS = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'OPT OUT', 'OPTOUT', 'END', 'STOPALL', 'REVOKE'];
const HELP_PATTERNS = ['HELP', 'ASSIST', 'SUPPORT', 'INFO', '?'];
const JOIN_PATTERNS = ['JOIN', 'START', 'SUBSCRIBE', 'OPTIN', 'OPT IN', 'RESUBSCRIBE', 'UNSTOP'];

/**
 * Hyphens/underscores read as spaces ("check-in" → "check in", "opt-out" →
 * "opt out"), runs of whitespace collapsed; case preserved. One character
 * maps to one character before collapsing, so a keyword's length in the
 * normalised form is its length here too (used to cut off the argument).
 */
export function collapseKeywordText(content: string | null | undefined): string {
  return String(content ?? '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Canonical text form used for every keyword comparison: collapsed (above),
 * upper case, trailing ?/!/. stripped ("Where is my driver?" →
 * "WHERE IS MY DRIVER", "Stop." → "STOP"). A message that is ONLY
 * punctuation (e.g. "?", a HELP synonym) is kept as is.
 */
export function normalizeKeywordText(content: string | null | undefined): string {
  return stripTrailingPunctuation(collapseKeywordText(content).toUpperCase());
}

function stripTrailingPunctuation(text: string): string {
  const stripped = text.replace(/[?!.]+$/, '').trim();
  return stripped === '' ? text : stripped;
}

/**
 * The universal (compliance) keywords use the same form WITHOUT the
 * hyphen → space mapping: STOP words are prefix-matched ("END …"), and
 * "end-of-day report" must not become an opt-out it never was before.
 */
function normalizeUniversalText(content: string | null | undefined): string {
  return stripTrailingPunctuation(String(content ?? '').replace(/\s+/g, ' ').trim().toUpperCase());
}

function matchesPattern(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => text === p || text.startsWith(p + ' '));
}

/** Which universal keyword (if any) a message is. Never consults tenant config. */
export function classifyUniversalKeyword(content: string | null | undefined): UniversalKeywordClass | null {
  const text = normalizeUniversalText(content);
  if (text === '') return null;
  if (matchesPattern(text, STOP_PATTERNS)) return 'STOP';
  if (matchesPattern(text, HELP_PATTERNS)) return 'HELP';
  if (text === 'YES' || text === 'Y') return 'YES';
  if (text === 'NO' || text === 'N') return 'NO';
  if (matchesPattern(text, JOIN_PATTERNS)) return 'JOIN';
  return null;
}

export function isReservedKeywordName(keyword: string): keyword is ReservedKeywordName {
  return (RESERVED_KEYWORD_NAMES as readonly string[]).includes(keyword);
}

export interface KeywordCommandInput {
  keyword: string;
  action: string;
  aliases?: unknown;
  responseText?: unknown;
  helpText?: unknown;
  workflowId?: unknown;
  enabled?: unknown;
}

export interface ValidKeywordCommand {
  keyword: string;
  action: 'reply' | 'dispatch';
  aliases: string[];
  responseText: string | null;
  helpText: string | null;
  workflowId: string | null;
  enabled: boolean;
}

const MAX_KEYWORD_LENGTH = 40;
const MAX_ALIASES = 10;
const MAX_RESPONSE_LENGTH = 480; // three concatenated SMS segments
const MAX_HELP_TEXT_LENGTH = 80;
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export class KeywordCommandValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'KeywordCommandValidationError';
  }
}

function optionalString(field: string, value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new KeywordCommandValidationError(field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) throw new KeywordCommandValidationError(field, `${field} must be at most ${max} characters`);
  return trimmed;
}

/**
 * Validates and canonicalises a keyword command definition. Throws
 * KeywordCommandValidationError with the offending field. Rules:
 *  - keyword / aliases: letters, digits and single spaces, ≤ 40 chars,
 *    stored normalised;
 *  - a reserved compliance keyword (STOP/START/HELP/YES/NO) may ONLY be a
 *    'reply' wording override; a HELP override must still tell the customer
 *    how to opt out (it must mention STOP), and a STOP override must mention
 *    START (how to opt back in), so a tenant cannot word away the compliance
 *    content of those replies;
 *  - any other keyword (and every alias) must NOT be swallowed by a universal
 *    pattern — otherwise the command could never fire, or worse, a tenant
 *    could believe "CANCEL MY ORDER" is their command when the platform
 *    (correctly) treats it as an opt-out;
 *  - 'reply' needs response text (unless disabled); 'dispatch' may carry an
 *    acknowledgement and a workflow id.
 */
export function validateKeywordCommand(input: KeywordCommandInput): ValidKeywordCommand {
  const keyword = normalizeKeywordText(input.keyword);
  if (!keyword || keyword.length > MAX_KEYWORD_LENGTH || !/^[A-Z0-9]+( [A-Z0-9]+)*$/.test(keyword)) {
    throw new KeywordCommandValidationError(
      'keyword',
      `keyword must be 1-${MAX_KEYWORD_LENGTH} letters/digits (single spaces allowed)`,
    );
  }
  if (input.action !== 'reply' && input.action !== 'dispatch') {
    throw new KeywordCommandValidationError('action', "action must be 'reply' or 'dispatch'");
  }
  const action = input.action;
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw new KeywordCommandValidationError('enabled', 'enabled must be a boolean');
  const responseText = optionalString('responseText', input.responseText, MAX_RESPONSE_LENGTH);
  const helpText = optionalString('helpText', input.helpText, MAX_HELP_TEXT_LENGTH);
  const workflowId = optionalString('workflowId', input.workflowId, 100);
  if (workflowId && !WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new KeywordCommandValidationError('workflowId', 'workflowId may contain letters, digits, ".", "_", ":" and "-"');
  }

  let aliases: string[] = [];
  if (input.aliases !== undefined && input.aliases !== null) {
    if (!Array.isArray(input.aliases) || input.aliases.some((a) => typeof a !== 'string')) {
      throw new KeywordCommandValidationError('aliases', 'aliases must be an array of strings');
    }
    if (input.aliases.length > MAX_ALIASES) {
      throw new KeywordCommandValidationError('aliases', `at most ${MAX_ALIASES} aliases`);
    }
    aliases = [...new Set((input.aliases as string[]).map((a) => normalizeKeywordText(a)))].filter((a) => a !== keyword);
    for (const alias of aliases) {
      if (!alias || alias.length > MAX_KEYWORD_LENGTH || !/^[A-Z0-9]+( [A-Z0-9]+)*$/.test(alias)) {
        throw new KeywordCommandValidationError('aliases', `alias "${alias}" must be 1-${MAX_KEYWORD_LENGTH} letters/digits`);
      }
    }
  }

  if (isReservedKeywordName(keyword)) {
    if (action !== 'reply') {
      throw new KeywordCommandValidationError('action', `${keyword} is a compliance keyword: only its reply wording can be configured (action 'reply')`);
    }
    if (workflowId) throw new KeywordCommandValidationError('workflowId', `${keyword} is a compliance keyword and cannot start a workflow`);
    if (aliases.length > 0) throw new KeywordCommandValidationError('aliases', `${keyword} is a compliance keyword: its synonyms are fixed by the platform`);
    if (helpText) throw new KeywordCommandValidationError('helpText', `${keyword} is always listed by the platform`);
    if (enabled && !responseText) throw new KeywordCommandValidationError('responseText', 'responseText is required');
    if (!enabled) {
      throw new KeywordCommandValidationError('enabled', `${keyword} is a compliance keyword and cannot be disabled`);
    }
    if (keyword === 'HELP' && !/\bSTOP\b/i.test(responseText ?? '')) {
      throw new KeywordCommandValidationError('responseText', 'a HELP reply must tell the customer how to opt out (mention STOP)');
    }
    if (keyword === 'STOP' && !/\b(START|JOIN)\b/i.test(responseText ?? '')) {
      throw new KeywordCommandValidationError('responseText', 'a STOP confirmation must tell the customer how to opt back in (mention START)');
    }
  } else {
    for (const candidate of [keyword, ...aliases]) {
      const universal = classifyUniversalKeyword(candidate);
      if (universal) {
        throw new KeywordCommandValidationError(
          candidate === keyword ? 'keyword' : 'aliases',
          `"${candidate}" is recognised by the platform as the universal ${universal === 'JOIN' ? 'START' : universal} keyword and cannot be an application command`,
        );
      }
    }
    if (action === 'reply' && enabled && !responseText) {
      throw new KeywordCommandValidationError('responseText', "responseText is required for a 'reply' command");
    }
    if (action === 'reply' && workflowId) {
      throw new KeywordCommandValidationError('workflowId', "workflowId only applies to 'dispatch' commands");
    }
  }

  return { keyword, action, aliases, responseText, helpText, workflowId, enabled };
}

/** The fields of a stored keyword_commands row the grammar needs. */
export interface KeywordCommandRowLike {
  keyword: string;
  tenantId: string | null;
  aliases: unknown;
  enabled: boolean;
}

export function aliasesOf(row: { aliases: unknown }): string[] {
  return Array.isArray(row.aliases) ? (row.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [];
}

/**
 * The commands in force for ONE owner: the application-wide rows
 * (tenant_id NULL) overlaid by that tenant's own rows, keyword by keyword (a
 * tenant row — including a disabled one — replaces the app-wide row with the
 * same keyword). Disabled rows are dropped from the result. Rows of any
 * other tenant are ignored even if passed in.
 */
export function mergeEffectiveKeywordCommands<T extends KeywordCommandRowLike>(rows: readonly T[], tenantId: string): T[] {
  const byKeyword = new Map<string, T>();
  for (const row of rows) if (row.tenantId === null) byKeyword.set(row.keyword, row);
  for (const row of rows) if (row.tenantId === tenantId) byKeyword.set(row.keyword, row);
  return [...byKeyword.values()].filter((r) => r.enabled).sort((a, b) => a.keyword.localeCompare(b.keyword));
}

/**
 * A phrase (keyword or alias) of `candidate` already claimed by a DIFFERENT
 * keyword among `existing` (an owner's effective commands) — two commands
 * answering to the same text would make dispatch depend on row order.
 */
export function findPhraseConflict(
  candidate: { keyword: string; aliases: string[] },
  existing: readonly KeywordCommandRowLike[],
): { phrase: string; claimedBy: string } | null {
  const phrases = [candidate.keyword, ...candidate.aliases];
  for (const row of existing) {
    if (row.keyword === candidate.keyword) continue; // the row being replaced
    const claimed = new Set([row.keyword, ...aliasesOf(row)]);
    for (const p of phrases) if (claimed.has(p)) return { phrase: p, claimedBy: row.keyword };
  }
  return null;
}
