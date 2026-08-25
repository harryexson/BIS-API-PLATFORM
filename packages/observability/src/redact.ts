// Redacts sensitive values and PII from arbitrary objects before logging.
//
// The following are NEVER emitted to logs:
//   - passwords / passphrases
//   - API keys / access keys / client secrets
//   - provider secrets / tokens / authorization headers
//   - card numbers / CVV / PAN / SSN / PIN / OTP
//   - email addresses and other unnecessary PII

const SENSITIVE_KEY =
  /(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|token|authorization|auth|cvv|cardnumber|card[_-]?number|cardno|pan|ssn|pin|otp|private[_-]?key)/i;

const CARD_VALUE = /\b(?:\d[ -]?){13,19}\b/;
const EMAIL_VALUE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export function redact(input: any, depth = 0): any {
  if (depth > 6) return '[omitted]';
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    let v = input;
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
