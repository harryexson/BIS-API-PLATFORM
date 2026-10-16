import {
  MESSAGE_CHANNELS,
  type MessageChannel,
  type MessageChannelPolicy,
  type MessageChannelSource,
} from '@company/schemas';

/**
 * Phase 10 (gap register A6/A8/A9): how an outbound message's channel is
 * decided, and the policy that decides whether it may ever change.
 *
 * Two clearly separate paths decide the REQUESTED channel:
 *
 *  1. EXPLICIT REQUEST — the caller sent `channel` ('sms' | 'whatsapp' |
 *     'email'). It is authoritative: nothing (content length, a 'wa:'
 *     substring, a provider override) overrides it.
 *  2. INFERRED DEFAULT — only when the caller sent no channel at all, for
 *     backward compatibility with callers written before the field existed:
 *     the legacy content heuristic (see inferChannelFromContent).
 *
 * Whatever the requested channel, it is NEVER silently changed afterwards:
 * routing only ever considers providers that declare that channel's
 * capability, and a different channel is used only when the caller opted
 * in for this message (MessageChannelPolicy.allowChannelSwitch === true),
 * with the reason recorded on the event's `fallbackReason`.
 */

export { MESSAGE_CHANNELS, type MessageChannel, type MessageChannelPolicy, type MessageChannelSource };

export function isMessageChannel(value: unknown): value is MessageChannel {
  return typeof value === 'string' && (MESSAGE_CHANNELS as readonly string[]).includes(value);
}

/** A send request that is invalid as a request (the gateway answers 400). */
export class InvalidMessageChannelRequestError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMessageChannelRequestError';
  }
}

/**
 * No provider of the requested channel could take the message, and no
 * permitted channel switch delivered it either. `reason` is specific (which
 * providers were unavailable or failed, and why no other channel was used).
 * Nothing was sent on any channel.
 */
export class MessageChannelUnavailableError extends Error {
  public readonly code = 'channel_unavailable';
  constructor(
    public readonly requestedChannel: MessageChannel,
    public readonly requestedChannelSource: MessageChannelSource,
    public readonly reason: string,
  ) {
    super(`Message not sent: requested channel '${requestedChannel}' is unavailable — ${reason}`);
    this.name = 'MessageChannelUnavailableError';
  }
}

/**
 * The address shape a channel can deliver to. Email needs an email address;
 * SMS/WhatsApp need a phone number (a 'whatsapp:'-scheme address is
 * WhatsApp-only). Deliberately shape-only — not a validator of real numbers.
 */
export function addressSuitsChannel(address: string, channel: MessageChannel): boolean {
  const a = String(address ?? '').trim();
  if (!a) return false;
  if (channel === 'email') return a.includes('@') && !/^whatsapp:/i.test(a);
  if (a.includes('@')) return false;
  if (channel === 'sms') return !/^whatsapp:/i.test(a);
  return true; // whatsapp: a bare phone number or a 'whatsapp:'-scheme one
}

/**
 * LEGACY, last-resort default — used ONLY when the caller did not request a
 * channel. Kept exactly as the platform behaved before Phase 10 (so existing
 * callers that never sent a channel see no change), plus the one
 * unambiguous signal that was previously ignored: a 'whatsapp:'-scheme
 * recipient address can only ever be WhatsApp.
 */
export function inferChannelFromContent(recipient: string, content: string): MessageChannel {
  const r = String(recipient ?? '');
  const c = String(content ?? '');
  if (r.includes('@')) return 'email';
  if (/^\s*whatsapp:/i.test(r)) return 'whatsapp';
  if (c.toLowerCase().includes('wa:') || c.length > 300) return 'whatsapp';
  return 'sms';
}

export interface RequestedChannel {
  channel: MessageChannel;
  source: MessageChannelSource;
  /** Human-readable note for decisionReason describing which path decided it. */
  note: string;
}

/**
 * Decide the requested channel. `overrideChannels` is the set of channels
 * the caller's providerOverride (if any, and if it exists) declares — used
 * only on the INFERRED path, where a provider the caller explicitly forced is
 * a stronger signal than a content heuristic (an SMS-only provider forced
 * for a 301-character body is an SMS, not a WhatsApp message).
 */
export function resolveRequestedChannel(input: {
  explicit: unknown;
  recipient: string;
  content: string;
  overrideId?: string;
  overrideChannels?: MessageChannel[];
}): RequestedChannel {
  if (input.explicit !== undefined && input.explicit !== null && input.explicit !== '') {
    const raw = typeof input.explicit === 'string' ? input.explicit.trim().toLowerCase() : input.explicit;
    if (!isMessageChannel(raw)) {
      throw new InvalidMessageChannelRequestError(
        'channel',
        `channel must be one of ${MESSAGE_CHANNELS.join(', ')} (got ${JSON.stringify(input.explicit)})`,
      );
    }
    if (input.recipient && !addressSuitsChannel(input.recipient, raw)) {
      throw new InvalidMessageChannelRequestError(
        'recipient',
        `recipient is not a valid ${raw} address for the explicitly requested channel '${raw}'`,
      );
    }
    return { channel: raw, source: 'explicit', note: `Channel '${raw}' explicitly requested by the caller.` };
  }

  const inferred = inferChannelFromContent(input.recipient, input.content);
  const overrideChannels = input.overrideChannels ?? [];
  if (input.overrideId && overrideChannels.length > 0 && !overrideChannels.includes(inferred)) {
    const fromOverride = overrideChannels.find((ch) => addressSuitsChannel(input.recipient, ch));
    if (fromOverride) {
      return {
        channel: fromOverride,
        source: 'inferred',
        note: `No channel requested; content inference suggested '${inferred}' but providerOverride '${input.overrideId}' only supports [${overrideChannels.join(', ')}] — defaulted to '${fromOverride}'.`,
      };
    }
  }
  return {
    channel: inferred,
    source: 'inferred',
    note: `No channel requested; defaulted to '${inferred}' by legacy content inference.`,
  };
}

/**
 * P1-4 / Phase 10: the channel fallback policy, as actually enforced by
 * RoutingEngine.routeMessage.
 */
export interface ChannelFallbackPolicy {
  /** Fail over between providers of the SAME channel (e.g. SignalHouse → FutureSMS). */
  allowAlternateProvider: boolean;
  /** Switch to a DIFFERENT channel (e.g. SMS → email) — off unless the caller opts in. */
  allowChannelSwitch: boolean;
  /**
   * A switched-to channel requires the recipient's affirmative consent on
   * THAT channel (an 'opted_in' consent record for the address used), not
   * merely the absence of an opt-out. Platform-enforced: a request cannot
   * turn it off.
   */
  requiresConsent: boolean;
}

export const DEFAULT_FALLBACK_POLICY: Readonly<ChannelFallbackPolicy> = Object.freeze({
  allowAlternateProvider: true,
  allowChannelSwitch: false,
  requiresConsent: true,
});

export interface EffectiveChannelPolicy extends ChannelFallbackPolicy {
  fallbackChannels: MessageChannel[];
  fallbackRecipients: Partial<Record<MessageChannel, string>>;
}

/**
 * Validate a request's channelPolicy. Returns a reason string when invalid
 * (the gateway answers 400 with it), or the normalized policy.
 */
export function parseChannelPolicy(
  raw: unknown,
): { ok: true; value: MessageChannelPolicy | undefined } | { ok: false; field: string; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, field: 'channelPolicy', message: 'channelPolicy must be an object' };
  }
  const p = raw as Record<string, unknown>;
  const known = new Set(['allowChannelSwitch', 'fallbackChannels', 'fallbackRecipients']);
  for (const key of Object.keys(p)) {
    if (!known.has(key)) {
      return { ok: false, field: `channelPolicy.${key}`, message: `unknown channelPolicy field '${key}' (allowed: ${[...known].join(', ')})` };
    }
  }
  if (p.allowChannelSwitch !== undefined && typeof p.allowChannelSwitch !== 'boolean') {
    return { ok: false, field: 'channelPolicy.allowChannelSwitch', message: 'allowChannelSwitch must be a boolean' };
  }
  let fallbackChannels: MessageChannel[] | undefined;
  if (p.fallbackChannels !== undefined) {
    if (!Array.isArray(p.fallbackChannels) || !p.fallbackChannels.every(isMessageChannel)) {
      return { ok: false, field: 'channelPolicy.fallbackChannels', message: `fallbackChannels must be an array of ${MESSAGE_CHANNELS.join(', ')}` };
    }
    if (new Set(p.fallbackChannels).size !== p.fallbackChannels.length) {
      return { ok: false, field: 'channelPolicy.fallbackChannels', message: 'fallbackChannels must not contain duplicates' };
    }
    fallbackChannels = p.fallbackChannels as MessageChannel[];
  }
  let fallbackRecipients: Partial<Record<MessageChannel, string>> | undefined;
  if (p.fallbackRecipients !== undefined) {
    if (typeof p.fallbackRecipients !== 'object' || p.fallbackRecipients === null || Array.isArray(p.fallbackRecipients)) {
      return { ok: false, field: 'channelPolicy.fallbackRecipients', message: 'fallbackRecipients must be an object keyed by channel' };
    }
    fallbackRecipients = {};
    for (const [ch, addr] of Object.entries(p.fallbackRecipients as Record<string, unknown>)) {
      if (!isMessageChannel(ch)) {
        return { ok: false, field: `channelPolicy.fallbackRecipients.${ch}`, message: `'${ch}' is not a channel (${MESSAGE_CHANNELS.join(', ')})` };
      }
      if (typeof addr !== 'string' || !addressSuitsChannel(addr, ch)) {
        return { ok: false, field: `channelPolicy.fallbackRecipients.${ch}`, message: `fallbackRecipients.${ch} must be a valid ${ch} address` };
      }
      fallbackRecipients[ch] = addr.trim();
    }
  }
  return {
    ok: true,
    value: {
      ...(p.allowChannelSwitch !== undefined ? { allowChannelSwitch: p.allowChannelSwitch as boolean } : {}),
      ...(fallbackChannels ? { fallbackChannels } : {}),
      ...(fallbackRecipients ? { fallbackRecipients } : {}),
    },
  };
}

/**
 * The policy routeMessage enforces for one message: the platform defaults,
 * with ONLY allowChannelSwitch (and its fallback order/addresses) taken
 * from the request. An unparseable request policy is rejected, never
 * half-applied.
 */
export function effectiveChannelPolicy(raw: unknown, requested: MessageChannel): EffectiveChannelPolicy {
  const parsed = parseChannelPolicy(raw);
  if (!parsed.ok) throw new InvalidMessageChannelRequestError(parsed.field, parsed.message);
  const req = parsed.value;
  const allowChannelSwitch = req?.allowChannelSwitch === true;
  const fallbackChannels = (req?.fallbackChannels ?? MESSAGE_CHANNELS.filter((c) => c !== requested))
    .filter((c) => c !== requested);
  return {
    ...DEFAULT_FALLBACK_POLICY,
    allowChannelSwitch,
    fallbackChannels: allowChannelSwitch ? fallbackChannels : [],
    fallbackRecipients: req?.fallbackRecipients ?? {},
  };
}

/**
 * Phase 10: the events-table columns (migration 0019) for a messaging
 * event's channel decision. Every durable messaging event write uses this,
 * so the audit row carries exactly what the event (and the API response)
 * said — chk_events_channel_fallback_reason then rejects a row that would
 * record a channel change without a reason.
 */
export function channelDecisionColumns(event: {
  requestedChannel?: MessageChannel;
  selectedChannel?: MessageChannel | null;
  fallbackReason?: string | null;
}): { requestedChannel: string | null; selectedChannel: string | null; fallbackReason: string | null } {
  return {
    requestedChannel: event.requestedChannel ?? null,
    selectedChannel: event.selectedChannel ?? null,
    fallbackReason: event.fallbackReason ?? null,
  };
}
