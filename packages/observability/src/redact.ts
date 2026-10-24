// Redacts sensitive values and PII from arbitrary objects before logging.
//
// The following are NEVER emitted to logs:
//   - passwords / passphrases
//   - API keys / access keys / client secrets
//   - provider secrets / tokens / authorization headers
//   - card numbers / CVV / PAN / SSN / PIN / OTP
//   - email addresses and other unnecessary PII
//
// Phase 22 (gap register C18): Error objects and secret-shaped VALUES are
// now handled too, not only secret-named KEYS:
//   - an Error is serialized (name, message, stack frames, enumerable props,
//     cause chain) and every part goes through the same redaction. Before
//     this, `JSON.stringify` of an Error is `{}` — and its ENUMERABLE props
//     passed through untouched, which for a drizzle DrizzleQueryError means
//     `params`: the raw bound values of the failed statement (phone numbers,
//     message bodies, payloads...).
//   - secret-shaped substrings are scrubbed IN PLACE inside any string
//     (including the log message itself, see logger.ts): the bound-parameter
//     tail of a "Failed query: ...\nparams: ..." DB error message, URL
//     credentials (postgres://user:PASSWORD@host, redis://:PASSWORD@host),
//     Bearer/Basic credentials, provider key shapes (sk_live_, whsec_...),
//     long hex secrets (platform API keys, webhook secrets) and E.164 phone
//     numbers. In-place, so the rest of the error text stays useful.

const SENSITIVE_KEY =
  /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|token|authorization|auth|cvv|cardnumber|card[_-]?number|cardno|pan|ssn|pin|otp|private[_-]?key)/i;

const CARD_VALUE = /\b(?:\d[ -]?){13,19}\b/;
const EMAIL_VALUE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Own properties of DB/driver errors that carry raw row / bound-parameter values. */
const ERROR_VALUE_KEYS = /^(params|parameters|bindings|values|detail)$/i;

const SECRET_VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // drizzle-orm DrizzleQueryError: "Failed query: <sql>\nparams: <raw values>".
  // The SQL (placeholders only) is kept; the bound values are not. The
  // lookahead keeps this idempotent.
  [/(Failed query: [\s\S]*?\nparams: )(?!\[REDACTED\])[\s\S]*/g, '$1[REDACTED]'],
  // Credentials embedded in a connection URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]*:)[^\s@/?#]+@/gi, '$1[REDACTED]@'],
  // HTTP credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g, '$1 [REDACTED]'],
  // Provider key shapes (Stripe secret/restricted/publishable keys, webhook secrets).
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g, '[REDACTED:key]'],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, '[REDACTED:key]'],
  // Long hex runs: raw platform API keys (64 hex), HMAC/webhook secrets, auth tokens.
  [/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED:hex]'],
  // E.164 phone numbers.
  [/\+[1-9]\d{7,14}\b/g, '[REDACTED:phone]'],
];

/**
 * Scrubs secret-shaped substrings in place. Does NOT apply the key-word /
 * whole-value rules, so it is safe on a free-text log message.
 */
export function redactText(value: string): string {
  let v = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) v = v.replace(pattern, replacement);
  return v;
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  for (const k of Object.keys(err)) {
    if (k === 'name' || k === 'message' || k === 'stack' || k === 'cause') continue;
    out[k] = ERROR_VALUE_KEYS.test(k) ? '[REDACTED]' : (err as any)[k];
  }
  if (typeof err.stack === 'string') {
    // The stack's first line repeats the message — keep only the frames so
    // the message is not emitted (and redacted) twice.
    const header = `${err.name}: ${err.message}`;
    out.stack = err.stack.startsWith(header) ? err.stack.slice(header.length).replace(/^\n/, '') : err.stack;
  }
  const cause = (err as any).cause;
  if (cause !== undefined) out.cause = cause;
  return out;
}

export function redact(input: any, depth = 0): any {
  if (depth > 6) return '[omitted]';
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    const v = redactText(input);
    if (SENSITIVE_KEY.test(v)) return '[REDACTED]';
    if (CARD_VALUE.test(v)) return '[REDACTED:card]';
    if (EMAIL_VALUE.test(v)) return '[REDACTED:email]';
    if (v.length > 2000) return v.slice(0, 2000) + '…[truncated]';
    return v;
  }

  if (typeof input === 'number' || typeof input === 'boolean') return input;

  if (Array.isArray(input)) {
    if (input.length > 200) return `[array:${input.length}]`;
    return input.map((i) => redact(i, depth + 1));
  }

  if (input instanceof Error) return redact(serializeError(input), depth);

  if (typeof input === 'object') {
    const keys = Object.keys(input);
    if (keys.length > 100) return '{object:too-large}';
    const out: any = {};
    for (const k of keys) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = redact(input[k], depth + 1);
    }
    return out;
  }

  return input;
}
