import {
  eventRepository,
  consentRecordRepository,
  normalizeKeywordText,
  collapseKeywordText,
  classifyUniversalKeyword,
  isReservedKeywordName,
  aliasesOf,
  type UniversalKeywordClass,
} from '@company/database';

/**
 * Inbound keyword commands.
 *
 * Phase 9 (gap register A13) split keywords into two kinds:
 *
 *  UNIVERSAL — recognised for every owner, consent semantics fixed here:
 *    STOP (+ UNSUBSCRIBE, CANCEL, QUIT, END, ...) → tenant-level opt-out
 *    START (+ JOIN, SUBSCRIBE, UNSTOP, ...)       → tenant-level opt-in
 *    HELP (+ INFO, SUPPORT, ?)                     → help reply
 *    YES / NO                                      → confirmation event
 *    An owner may override only the REPLY WORDING of these (keyword_commands
 *    rows named STOP/START/HELP/YES/NO, action 'reply').
 *
 *  CONFIGURED — everything else, defined per application / tenant in
 *    keyword_commands (e.g. Reach Church: PRAY, CHECK IN; HaulPro: WHERE IS
 *    MY DRIVER). 'reply' commands answer with the owner's own text;
 *    'dispatch' commands are handed to the owning application (the inbound
 *    worker records a durable dispatch and emits a tenant-scoped event) —
 *    the platform never invents the business answer.
 *
 * Previously PRAY was hard-coded here with church wording and the HELP reply
 * advertised "PRAY (prayer request)" to every tenant on the platform,
 * including logistics and marketplace tenants; CHECK IN and WHERE IS MY
 * DRIVER did not exist at all.
 *
 * handleKeyword() is only ever called once the Phase 8 resolver has
 * attributed the message to exactly ONE owner; `commands` must be THAT
 * owner's effective configuration (keywordCommandRepository
 * .findEffectiveForOwner), never another tenant's.
 */

/** One configured command, as stored in keyword_commands (or a test double). */
export interface KeywordCommandConfig {
  id?: string | null;
  keyword: string;
  aliases?: unknown;
  action: string;
  responseText?: string | null;
  helpText?: string | null;
  workflowId?: string | null;
}

export interface KeywordContext {
  senderPhone: string;
  appId: string;
  tenantId: string;
  content: string;
  providerId: string;
  // Channel the keyword arrived on (sms/whatsapp/email/...), used to scope
  // the consent record. Defaults to 'sms' when the caller doesn't know it.
  channel?: string;
  // Phase 8: the supplier/business the message was attributed to, when
  // the conversation is supplier-scoped (recorded on keyword events).
  supplierId?: string | null;
  // Phase 9: the owner's effective keyword configuration. Absent/empty = the
  // owner configured nothing: only the universal keywords exist for it.
  commands?: readonly KeywordCommandConfig[];
  // Phase 9 audit context, recorded on every keyword event.
  conversationId?: string | null;
  attribution?: string | null;
  holdId?: string | null;
}

export interface KeywordCommandMatch {
  command: KeywordCommandConfig;
  /** The command's canonical keyword (e.g. 'WHERE IS MY DRIVER'). */
  keyword: string;
  /** The keyword or alias the message matched. */
  phrase: string;
  /** Text after the keyword ("CHECK IN 4421" → "4421"), if any. */
  argument: string | null;
}

export interface KeywordResult {
  handled: boolean;
  response?: string;
  action?: 'opt_out' | 'opt_in' | 'help' | 'confirmation' | 'command';
  /** Canonical keyword handled: STOP / START / HELP / YES / NO, or the configured command's keyword. */
  keyword?: string;
  /** Set for a configured command. */
  command?: {
    commandId: string | null;
    keyword: string;
    mode: 'reply' | 'dispatch';
    workflowId: string | null;
    argument: string | null;
  };
}

/**
 * Which UNIVERSAL keyword (if any) a message is, WITHOUT acting on it. The
 * inbound worker uses this to label a quarantined (ambiguous) message — a
 * held STOP in particular — while handleKeyword(), which records consent and
 * events against a tenant, is only ever called once the owner is known.
 * Never returns an application-specific command: what "PRAY" means depends
 * on which tenant the message belongs to.
 */
export type KeywordClass = UniversalKeywordClass;

export function classifyKeyword(content: string): KeywordClass | null {
  return classifyUniversalKeyword(content);
}

export const DEFAULT_KEYWORD_RESPONSES = {
  STOP: 'You have been unsubscribed and will receive no further messages from this service. Reply START to resubscribe.',
  START: 'You have been resubscribed to this service. Reply STOP to unsubscribe at any time, HELP for help.',
  HELP: 'Reply STOP to unsubscribe, START to resubscribe, HELP for help.',
  YES: 'Thank you for your confirmation.',
  NO: 'Understood. Reply HELP for available commands.',
} as const;

function reservedOverride(commands: readonly KeywordCommandConfig[] | undefined, name: string): string | null {
  const row = commands?.find((c) => c.keyword === name && c.action === 'reply');
  return row?.responseText?.trim() ? row.responseText.trim() : null;
}

function appCommands(commands: readonly KeywordCommandConfig[] | undefined): KeywordCommandConfig[] {
  return (commands ?? []).filter((c) => !isReservedKeywordName(c.keyword) && (c.action === 'reply' || c.action === 'dispatch'));
}

/**
 * Match a message against an owner's configured (non-universal) commands:
 * the whole message is the keyword/alias, or starts with it followed by a
 * space (the rest becomes `argument`). The longest phrase wins ("CHECK IN"
 * beats "CHECK"). Universal keywords are NOT considered here — callers check
 * them first, so no configured command can shadow STOP/START/HELP/YES/NO.
 */
export function matchKeywordCommand(
  content: string,
  commands: readonly KeywordCommandConfig[] | undefined,
): KeywordCommandMatch | null {
  const text = normalizeKeywordText(content);
  if (!text) return null;
  let best: KeywordCommandMatch | null = null;
  for (const command of appCommands(commands)) {
    for (const phrase of [command.keyword, ...aliasesOf({ aliases: command.aliases })]) {
      if (!(text === phrase || text.startsWith(phrase + ' '))) continue;
      if (best && best.phrase.length >= phrase.length) continue;
      best = { command, keyword: command.keyword, phrase, argument: argumentAfter(content, phrase) };
    }
  }
  return best;
}

function argumentAfter(content: string, phrase: string): string | null {
  // Same collapsing as normalizeKeywordText, original case kept.
  const collapsed = collapseKeywordText(content);
  const rest = collapsed.slice(phrase.length).trim();
  return rest === '' || /^[?!.]+$/.test(rest) ? null : rest;
}

/**
 * The owner's HELP reply. Lists ONLY the universal keywords plus the
 * commands THIS owner configured with a helpText — a logistics tenant is
 * never told about prayer requests. A HELP wording override may embed the
 * listing with the {commands} placeholder.
 */
export function buildHelpResponse(commands: readonly KeywordCommandConfig[] | undefined): string {
  const listed = appCommands(commands)
    .filter((c) => c.helpText && c.helpText.trim())
    .map((c) => `${c.keyword} (${c.helpText!.trim()})`);
  const listing = listed.length > 0 ? `Commands: ${listed.join(', ')}.` : '';
  const override = reservedOverride(commands, 'HELP');
  if (override) {
    return override.includes('{commands}') ? override.replace('{commands}', listing).replace(/\s+/g, ' ').trim() : override;
  }
  return listing ? `${DEFAULT_KEYWORD_RESPONSES.HELP} ${listing}` : DEFAULT_KEYWORD_RESPONSES.HELP;
}

export async function handleKeyword(ctx: KeywordContext): Promise<KeywordResult> {
  // Universal keywords first — they can never be shadowed by configuration.
  switch (classifyUniversalKeyword(ctx.content)) {
    case 'STOP':
      return handleStop(ctx);
    case 'HELP':
      return handleHelp(ctx);
    case 'YES':
      return handleConfirmation(ctx, true);
    case 'NO':
      return handleConfirmation(ctx, false);
    case 'JOIN':
      return handleJoin(ctx);
    default:
      break;
  }

  const match = matchKeywordCommand(ctx.content, ctx.commands);
  if (match) return handleCommand(ctx, match);

  // Not a keyword for this owner.
  return { handled: false };
}

function auditPayload(ctx: KeywordContext, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sender: ctx.senderPhone,
    content: ctx.content,
    ...extra,
    tenantId: ctx.tenantId,
    ...(ctx.supplierId ? { supplierId: ctx.supplierId } : {}),
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx.attribution ? { attribution: ctx.attribution } : {}),
    ...(ctx.holdId ? { holdId: ctx.holdId } : {}),
    channel: ctx.channel || 'sms',
  };
}

async function audit(ctx: KeywordContext, decisionReason: string, extra: Record<string, unknown>): Promise<void> {
  try {
    await eventRepository.create({
      appId: ctx.appId,
      // Phase 16 (gap register D14/D16): tenant in the column, not only in
      // the payload.
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      category: 'inbound',
      providerId: ctx.providerId,
      status: 'success',
      decisionReason,
      payload: auditPayload(ctx, extra),
    });
  } catch {
    // Best-effort once the consent state itself is durably recorded (see
    // keywords.test.ts). The consent row (source/keyword/updated_at) and, on
    // a shared number, the sender_opt_outs row (with its hold link) remain.
  }
}

async function handleStop(ctx: KeywordContext): Promise<KeywordResult> {
  // Gap register A5 (Phase 8): the consent write is NOT best-effort — a
  // failed write throws, failing the inbound job so it is retried, instead
  // of telling the customer "unsubscribed" while sends continue.
  //
  // Deliberately does NOT close the conversation: inbound routing
  // (ConversationResolver) needs it ACTIVE to attribute a later START to
  // this owner. The conversation is suppressed by consent instead — every
  // outbound send to this recipient is refused by the router (403) until an
  // explicit opt-in.
  await consentRecordRepository.upsert({
    appId: ctx.appId,
    tenantId: ctx.tenantId,
    recipient: ctx.senderPhone,
    channel: ctx.channel || 'sms',
    status: 'opted_out',
    source: 'keyword',
    keyword: 'STOP',
  });
  await audit(ctx, 'keyword_stop', { keyword: 'STOP', action: 'opt_out' });
  return {
    handled: true,
    action: 'opt_out',
    keyword: 'STOP',
    response: reservedOverride(ctx.commands, 'STOP') ?? DEFAULT_KEYWORD_RESPONSES.STOP,
  };
}

async function handleJoin(ctx: KeywordContext): Promise<KeywordResult> {
  // Phase 9 START decision: an explicit STOP to a business needs an
  // explicit re-opt-in to THAT business. START therefore restores
  // eligibility for the ONE owner the message was attributed to and never
  // re-subscribes any other tenant. On a shared number the inbound worker
  // additionally clears the carrier-level number block (sender_opt_outs —
  // the carrier itself re-enables the number on START); an AMBIGUOUS START
  // clears only that number block and re-subscribes no tenant until an
  // operator attributes it (keyword-commands.scenarios.ts, Problem 3).
  // Not best-effort: a lost opt-in would leave the customer blocked after
  // being told they were re-subscribed.
  await consentRecordRepository.upsert({
    appId: ctx.appId,
    tenantId: ctx.tenantId,
    recipient: ctx.senderPhone,
    channel: ctx.channel || 'sms',
    status: 'opted_in',
    source: 'keyword',
    keyword: 'JOIN',
  });
  await audit(ctx, 'keyword_join', { keyword: 'JOIN', action: 'opt_in' });
  return {
    handled: true,
    action: 'opt_in',
    keyword: 'START',
    response: reservedOverride(ctx.commands, 'START') ?? DEFAULT_KEYWORD_RESPONSES.START,
  };
}

async function handleHelp(ctx: KeywordContext): Promise<KeywordResult> {
  await audit(ctx, 'keyword_help', { keyword: 'HELP', action: 'help' });
  return { handled: true, action: 'help', keyword: 'HELP', response: buildHelpResponse(ctx.commands) };
}

async function handleConfirmation(ctx: KeywordContext, confirmed: boolean): Promise<KeywordResult> {
  const keyword = confirmed ? 'YES' : 'NO';
  await audit(ctx, `keyword_${confirmed ? 'yes' : 'no'}`, { keyword, action: 'confirmation', confirmed });
  return {
    handled: true,
    action: 'confirmation',
    keyword,
    response: reservedOverride(ctx.commands, keyword) ?? DEFAULT_KEYWORD_RESPONSES[keyword],
  };
}

async function handleCommand(ctx: KeywordContext, match: KeywordCommandMatch): Promise<KeywordResult> {
  const mode: 'reply' | 'dispatch' = match.command.action === 'dispatch' ? 'dispatch' : 'reply';
  const workflowId = mode === 'dispatch' ? match.command.workflowId ?? null : null;
  await audit(ctx, `keyword_command:${match.keyword}`, {
    keyword: match.keyword,
    action: 'command',
    mode,
    matched: match.phrase,
    argument: match.argument,
    commandId: match.command.id ?? null,
    workflowId,
  });
  const response = match.command.responseText?.trim() || undefined;
  return {
    handled: true,
    action: 'command',
    keyword: match.keyword,
    ...(response ? { response } : {}),
    command: {
      commandId: match.command.id ?? null,
      keyword: match.keyword,
      mode,
      workflowId,
      argument: match.argument,
    },
  };
}
