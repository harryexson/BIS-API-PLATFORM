/**
 * Phase 8 — one canonical form for messaging addresses (customer numbers,
 * shared business numbers, short codes), used on EVERY write and lookup of
 * conversations / messaging_profiles / inbound holds / sender opt-outs.
 *
 * Before this, nothing in the inbound path normalised anything (gap
 * register A3.5): '+1 (555) 010-0000', '+15550100000' and
 * 'whatsapp:+15550100000' were three different customers, and an inbound
 * STOP in one format silently missed a conversation stored in another.
 *
 * Rules (kept deliberately conservative — never invents a country code):
 *  - trim; strip a leading 'whatsapp:' / 'sms:' / 'tel:' scheme
 *  - if what remains, minus spaces/dashes/dots/parentheses, is an optional
 *    '+' followed by digits, return that (phone numbers and short codes)
 *  - otherwise (alphanumeric sender IDs, e-mail addresses) return the
 *    trimmed, scheme-stripped value unchanged
 *
 * Migration 0017 applies the identical rule in SQL to existing rows.
 */
export function normalizeMessagingAddress(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.trim().replace(/^(whatsapp|sms|tel):/i, '');
  const compact = stripped.replace(/[\s().-]/g, '');
  if (/^\+?[0-9]+$/.test(compact)) return compact;
  return stripped.trim();
}

/** The channel implied by an address's scheme, if any ('whatsapp:+1...' → 'whatsapp'). */
export function channelFromAddress(raw: unknown): 'whatsapp' | undefined {
  return typeof raw === 'string' && /^\s*whatsapp:/i.test(raw) ? 'whatsapp' : undefined;
}
