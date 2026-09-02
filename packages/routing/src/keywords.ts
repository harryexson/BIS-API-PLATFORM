import { conversationRepository, eventRepository } from '@company/database';

export interface KeywordContext {
  senderPhone: string;
  appId: string;
  tenantId: string;
  content: string;
  providerId: string;
}

export interface KeywordResult {
  handled: boolean;
  response?: string;
  action?: 'opt_out' | 'opt_in' | 'help' | 'prayer' | 'confirmation' | 'unknown';
}

/**
 * Keyword command handler for inbound messages.
 *
 * Processes common SMS/WhatsApp keywords like STOP, HELP, YES, NO, PRAY.
 * Each keyword triggers a specific action and returns a response message.
 *
 * STOP/UNSUBSCRIBE — Opts the user out, closes conversation
 * HELP — Returns help information
 * YES/NO — Confirmation responses (for opt-in flows, surveys, etc.)
 * PRAY — Triggers a prayer request flow
 */
export async function handleKeyword(ctx: KeywordContext): Promise<KeywordResult> {
  const normalized = ctx.content.trim().toUpperCase();

  // Check for STOP/UNSUBSCRIBE keywords (TCPA compliance)
  if (isStopKeyword(normalized)) {
    return handleStop(ctx);
  }

  // Check for HELP keywords
  if (isHelpKeyword(normalized)) {
    return handleHelp(ctx);
  }

  // Check for YES/NO confirmation keywords
  if (normalized === 'YES' || normalized === 'Y') {
    return handleConfirmation(ctx, true);
  }
  if (normalized === 'NO' || normalized === 'N') {
    return handleConfirmation(ctx, false);
  }

  // Check for PRAY keyword
  if (normalized === 'PRAY' || normalized === 'PRAYER') {
    return handlePrayer(ctx);
  }

  // Check for JOIN/START keywords (opt-in / re-subscribe)
  if (isJoinKeyword(normalized)) {
    return handleJoin(ctx);
  }

  // Not a recognized keyword
  return { handled: false };
}

function isStopKeyword(text: string): boolean {
  const stopPatterns = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'OPT OUT', 'OPTOUT', 'END'];
  return stopPatterns.some((p) => text === p || text.startsWith(p + ' '));
}

function isHelpKeyword(text: string): boolean {
  const helpPatterns = ['HELP', 'ASSIST', 'SUPPORT', 'INFO', '?'];
  return helpPatterns.some((p) => text === p || text.startsWith(p + ' '));
}

function isJoinKeyword(text: string): boolean {
  const joinPatterns = ['JOIN', 'START', 'SUBSCRIBE', 'OPTIN', 'OPT IN', 'RESUBSCRIBE'];
  return joinPatterns.some((p) => text === p || text.startsWith(p + ' '));
}

async function handleStop(ctx: KeywordContext): Promise<KeywordResult> {
  // Close the conversation (opt-out)
  try {
    await conversationRepository.close(ctx.senderPhone, ctx.appId, ctx.tenantId);

    // Log the opt-out event
    await eventRepository.create({
      appId: ctx.appId,
      category: 'inbound',
      providerId: ctx.providerId,
      status: 'success',
      decisionReason: 'keyword_stop',
      payload: {
        sender: ctx.senderPhone,
        content: ctx.content,
        keyword: 'STOP',
        action: 'opt_out',
        tenantId: ctx.tenantId,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    handled: true,
    action: 'opt_out',
    response:
      'You have been unsubscribed from this service. Reply JOIN to re-subscribe.',
  };
}

async function handleHelp(ctx: KeywordContext): Promise<KeywordResult> {
  try {
    await eventRepository.create({
      appId: ctx.appId,
      category: 'inbound',
      providerId: ctx.providerId,
      status: 'success',
      decisionReason: 'keyword_help',
      payload: {
        sender: ctx.senderPhone,
        content: ctx.content,
        keyword: 'HELP',
        tenantId: ctx.tenantId,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    handled: true,
    action: 'help',
    response:
      'Available commands: STOP (unsubscribe), HELP (this message), PRAY (prayer request). Reply with any keyword for more info.',
  };
}

async function handleConfirmation(ctx: KeywordContext, confirmed: boolean): Promise<KeywordResult> {
  try {
    await eventRepository.create({
      appId: ctx.appId,
      category: 'inbound',
      providerId: ctx.providerId,
      status: 'success',
      decisionReason: `keyword_${confirmed ? 'yes' : 'no'}`,
      payload: {
        sender: ctx.senderPhone,
        content: ctx.content,
        keyword: confirmed ? 'YES' : 'NO',
        action: 'confirmation',
        confirmed,
        tenantId: ctx.tenantId,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    handled: true,
    action: 'confirmation',
    response: confirmed
      ? 'Thank you for your confirmation.'
      : 'Understood. Reply HELP for available commands.',
  };
}

async function handlePrayer(ctx: KeywordContext): Promise<KeywordResult> {
  try {
    await eventRepository.create({
      appId: ctx.appId,
      category: 'inbound',
      providerId: ctx.providerId,
      status: 'success',
      decisionReason: 'keyword_prayer',
      payload: {
        sender: ctx.senderPhone,
        content: ctx.content,
        keyword: 'PRAY',
        action: 'prayer_request',
        tenantId: ctx.tenantId,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    handled: true,
    action: 'prayer',
    response:
      'Your prayer request has been received. Our team will be praying for you. Reply STOP to unsubscribe.',
  };
}

async function handleJoin(ctx: KeywordContext): Promise<KeywordResult> {
  try {
    // Log the opt-in event
    await eventRepository.create({
      appId: ctx.appId,
      category: 'inbound',
      providerId: ctx.providerId,
      status: 'success',
      decisionReason: 'keyword_join',
      payload: {
        sender: ctx.senderPhone,
        content: ctx.content,
        keyword: 'JOIN',
        action: 'opt_in',
        tenantId: ctx.tenantId,
      },
    });
  } catch {
    // Non-fatal
  }

  return {
    handled: true,
    action: 'opt_in',
    response:
      'You have been subscribed to this service. Reply STOP to unsubscribe at any time.',
  };
}
