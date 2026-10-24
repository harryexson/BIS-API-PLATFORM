import type { ProviderConfig, ProviderEnvironment, ProviderStatus, RoutingRule } from './index';

// ----------------------------------------------------
// REQUEST-FIELD VALIDATION (gap register C10 / F11, Phase 17-18)
// ----------------------------------------------------
// The gateway used to check only that these fields were PRESENT (or, for
// payment amounts, that Number() of them was a positive finite number), so
// e.g. `amount: true` charged 1.00, `amount: "-5"` created a checkout
// session, a message with a whitespace body was sent, and an admin PATCH
// spread whatever JSON it was given into a provider's live configuration.
//
// These are plain, dependency-free parsers in the same shape the gateway
// already used for its other request fields (parsePaymentExtras,
// parseMessagingChannelFields): each returns either the validated value or
// the offending field plus a human-readable reason, which the gateway turns
// into `400 { error: { code: 'invalid_request', field, message } }`.

export type FieldValidation<T> = { ok: true; value: T } | { ok: false; field: string; message: string };

const ok = <T>(value: T): FieldValidation<T> => ({ ok: true, value });
const fail = <T = never>(field: string, message: string): FieldValidation<T> => ({ ok: false, field, message });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const isAbsent = (v: unknown) => v === undefined || v === null || v === '';

// ----------------------------------------------------
// Money
// ----------------------------------------------------
//
// UNIT: every amount on the public API is in MAJOR currency units — 49.99
// means USD 49.99, not 49.99 cents. That is what the whole platform does
// internally: the gateway stores it as-is in the `numeric` transactions /
// checkout_sessions columns, routing's fee scoring treats it as currency
// units, and each payment adapter converts FROM major units to its
// provider's own wire format (Stripe/Adyen/Checkout.com/Paystack/Square:
// Math.round(amount * 100) minor units; Braintree/NMI/PayPal/Authorize.Net/
// PawaPay: a 2-decimal string; Airwallex/Flutterwave/PayChangu: the decimal
// as-is). See docs/openapi.yaml (MoneyAmount).
//
// PRECISION: at most 2 decimal places — the precision every adapter's
// conversion above assumes. Anything finer (49.999999) would be silently
// rounded by some adapters and sent verbatim by others, so it is refused
// rather than guessed at.
//
// BOUND: MAX_MONEY_AMOUNT is a sanity bound against garbage/overflow (it
// keeps amount * 100 an exact integer), not a business limit — providers
// apply their own per-transaction limits.
export const MAX_MONEY_AMOUNT = 1_000_000_000;
export const MONEY_AMOUNT_MAX_DECIMALS = 2;
const MONEY_AMOUNT_TEXT = /^\d+(\.\d{1,2})?$/;

/**
 * A positive amount in MAJOR currency units with at most 2 decimal places:
 * a JSON number (49.99) or a plain decimal string ("49.99"). Rejects
 * booleans, arrays, objects, hex/exponent/whitespace-padded strings, zero,
 * negatives, NaN/Infinity, more than 2 decimals, and values above
 * MAX_MONEY_AMOUNT.
 */
export function parseMoneyAmount(raw: unknown, field = 'amount'): FieldValidation<number> {
  const shape = `${field} must be a positive number in major currency units (e.g. 49.99 for USD 49.99) with at most ${MONEY_AMOUNT_MAX_DECIMALS} decimal places`;
  if (raw === undefined || raw === null || raw === '') return fail(field, `${field} is required: ${shape}`);
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail(field, shape);
    // Shortest round-trip form: 49.99 → "49.99", 0.1 + 0.2 → "0.30000000000000004".
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return fail(field, shape);
  }
  if (!MONEY_AMOUNT_TEXT.test(text)) return fail(field, shape);
  const value = Number(text);
  if (!(value > 0)) return fail(field, `${field} must be greater than 0`);
  if (value > MAX_MONEY_AMOUNT) return fail(field, `${field} must be at most ${MAX_MONEY_AMOUNT}`);
  return ok(value);
}

/**
 * An ISO 4217 alphabetic currency code (3 letters). Returned exactly as sent
 * (routing and the adapters upper-case it themselves). When not `required`,
 * an absent value (undefined / null / '') is `undefined` — the caller
 * applies its documented default.
 */
export function parseCurrencyCode(raw: unknown, opts: { required: boolean; field?: string }): FieldValidation<string | undefined> {
  const field = opts.field ?? 'currency';
  if (isAbsent(raw)) {
    return opts.required ? fail(field, `${field} is required (a 3-letter ISO 4217 code, e.g. USD)`) : ok(undefined);
  }
  if (typeof raw !== 'string' || !/^[A-Za-z]{3}$/.test(raw)) {
    return fail(field, `${field} must be a 3-letter ISO 4217 currency code (e.g. USD)`);
  }
  return ok(raw);
}

// ----------------------------------------------------
// Messaging
// ----------------------------------------------------

export const MAX_MESSAGE_CONTENT_LENGTH = 16_384;
export const MAX_EMAIL_ADDRESS_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// After an optional 'whatsapp:' / 'sms:' / 'tel:' scheme and the usual
// separators (spaces, dots, dashes, parentheses): an optional '+' and 3-15
// digits (E.164's maximum is 15; short codes are shorter).
const PHONE_SHAPE = /^\+?[0-9]{3,15}$/;

/**
 * A plausible message recipient: an email address, or a phone number
 * (optionally with a 'whatsapp:' / 'sms:' / 'tel:' scheme and formatting
 * separators). Shape-only — it does not prove the number/mailbox exists.
 * Returned exactly as sent; routing/consent normalise addresses themselves.
 */
export function parseMessageRecipient(raw: unknown, field = 'recipient'): FieldValidation<string> {
  if (isAbsent(raw)) return fail(field, `${field} is required: a phone number (e.g. +265888000111) or an email address`);
  if (typeof raw !== 'string') return fail(field, `${field} must be a string: a phone number or an email address`);
  const address = raw.trim();
  if (!address) return fail(field, `${field} must not be blank`);
  if (address.includes('@') && !/^whatsapp:/i.test(address)) {
    if (address.length > MAX_EMAIL_ADDRESS_LENGTH || !EMAIL_SHAPE.test(address)) {
      return fail(field, `${field} is not a valid email address`);
    }
    return ok(raw);
  }
  const digits = address.replace(/^(whatsapp|sms|tel):/i, '').replace(/[\s().-]/g, '');
  if (!PHONE_SHAPE.test(digits)) {
    return fail(field, `${field} must be a phone number (optional leading +, 3-15 digits) or an email address`);
  }
  return ok(raw);
}

/** A non-blank message body of at most MAX_MESSAGE_CONTENT_LENGTH characters. */
export function parseMessageContent(raw: unknown, field = 'content'): FieldValidation<string> {
  if (raw === undefined || raw === null) return fail(field, `${field} is required`);
  if (typeof raw !== 'string') return fail(field, `${field} must be a string`);
  if (raw.trim() === '') return fail(field, `${field} must not be empty`);
  if (raw.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return fail(field, `${field} must be at most ${MAX_MESSAGE_CONTENT_LENGTH} characters`);
  }
  return ok(raw);
}

// ----------------------------------------------------
// Admin provider configuration
// ----------------------------------------------------
//
// PATCH /api/dashboard/providers/:id (and .../management) used to spread
// the raw request body into the provider's live config. Since Phase 15 that
// config is persisted and synced to every replica — but only the fields of
// PersistableProviderManagement are, each type-checked on load. So anything
// else the body carried (a `name`/`category` rename, telemetry such as
// `health`), or a persisted field of the wrong type (a string `weight`, a
// string `currencies` that the persistence layer then spread into
// ["U","S","D"]), was applied on the writing replica and NOT (or differently)
// on every other one: gap register PHASE15-02/PHASE15-03.
//
// The parsers below accept exactly the persisted, admin-controlled fields,
// each with its real type and range, normalised the way routing compares
// them (country/currency codes upper-case), so what the writer applies is
// byte-for-byte what every replica loads. Anything else is a 400.

export type ProviderConfigUpdate = Partial<
  Pick<ProviderConfig, 'status' | 'weight' | 'latencyMin' | 'latencyMax' | 'transactionFeePercent' | 'transactionFeeFlat' | 'messageCost'>
>;

export interface ProviderManagementUpdate extends ProviderConfigUpdate {
  priority?: number;
  environment?: ProviderEnvironment;
  countries?: string[];
  currencies?: string[];
  capabilities?: string[];
  routingRules?: RoutingRule[];
}

const PROVIDER_STATUSES: readonly ProviderStatus[] = ['online', 'offline', 'maintenance'];
const PROVIDER_ENVIRONMENTS: readonly ProviderEnvironment[] = ['test', 'live'];
const MAX_LIST_ENTRIES = 300;
const MAX_ROUTING_RULES = 100;
const MAX_LATENCY_MS = 600_000;
const MAX_FLAT_FEE = 1_000_000;

const CONFIG_FIELDS = ['status', 'weight', 'latencyMin', 'latencyMax', 'transactionFeePercent', 'transactionFeeFlat', 'messageCost'] as const;
const MANAGEMENT_FIELDS = [...CONFIG_FIELDS, 'priority', 'environment', 'countries', 'currencies', 'capabilities', 'routingRules'] as const;

function numberInRange(raw: unknown, field: string, min: number, max: number): FieldValidation<number> {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(field, `${field} must be a number`);
  if (raw < min || raw > max) return fail(field, `${field} must be between ${min} and ${max}`);
  return ok(raw);
}

function codeList(raw: unknown, field: string, pattern: RegExp, example: string): FieldValidation<string[]> {
  if (!Array.isArray(raw)) return fail(field, `${field} must be an array of codes (e.g. ${example}), not ${typeof raw === 'string' ? 'a string' : typeof raw}`);
  if (raw.length > MAX_LIST_ENTRIES) return fail(field, `${field} must have at most ${MAX_LIST_ENTRIES} entries`);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !(entry === '*' || pattern.test(entry))) {
      return fail(field, `${field} entries must be codes like ${example} or '*' (got ${JSON.stringify(entry)})`);
    }
    out.push(entry.toUpperCase());
  }
  return ok(out);
}

function capabilityList(raw: unknown, field: string): FieldValidation<string[]> {
  if (!Array.isArray(raw)) return fail(field, `${field} must be an array of capability names (e.g. ["card"]), not ${typeof raw === 'string' ? 'a string' : typeof raw}`);
  if (raw.length > MAX_LIST_ENTRIES) return fail(field, `${field} must have at most ${MAX_LIST_ENTRIES} entries`);
  for (const entry of raw) {
    if (typeof entry !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(entry)) {
      return fail(field, `${field} entries must be capability names like "card" or "mobile_money" (got ${JSON.stringify(entry)})`);
    }
  }
  return ok([...raw] as string[]);
}

function routingRuleList(raw: unknown, field: string): FieldValidation<RoutingRule[]> {
  if (!Array.isArray(raw)) return fail(field, `${field} must be an array of routing rules`);
  if (raw.length > MAX_ROUTING_RULES) return fail(field, `${field} must have at most ${MAX_ROUTING_RULES} rules`);
  const out: RoutingRule[] = [];
  for (const [i, r] of raw.entries()) {
    const at = `${field}[${i}]`;
    if (!isPlainObject(r)) return fail(at, `${at} must be an object`);
    const unknownKey = Object.keys(r).find((k) => !['id', 'match', 'target', 'description', 'enabled'].includes(k));
    if (unknownKey) return fail(`${at}.${unknownKey}`, `${at}.${unknownKey} is not a routing-rule field (id, match, target, description, enabled)`);
    for (const key of ['id', 'match', 'target'] as const) {
      const v = r[key];
      if (typeof v !== 'string' || v.trim() === '' || v.length > 512) return fail(`${at}.${key}`, `${at}.${key} must be a non-empty string`);
    }
    if (r.description !== undefined && (typeof r.description !== 'string' || r.description.length > 512)) {
      return fail(`${at}.description`, `${at}.description must be a string`);
    }
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return fail(`${at}.enabled`, `${at}.enabled must be a boolean`);
    out.push({
      id: r.id as string,
      match: r.match as string,
      target: r.target as string,
      ...(r.description !== undefined ? { description: r.description as string } : {}),
      // Stored explicitly so the writer and every replica (which treats a
      // missing `enabled` as true when loading) hold the same value.
      enabled: r.enabled !== false,
    });
  }
  return ok(out);
}

function parseProviderUpdate(
  body: unknown,
  allowed: readonly string[],
): FieldValidation<ProviderManagementUpdate> {
  if (!isPlainObject(body)) return fail('body', 'request body must be a JSON object of provider fields to update');
  const keys = Object.keys(body);
  const unknownKey = keys.find((k) => !allowed.includes(k));
  if (unknownKey) {
    return fail(unknownKey, `${unknownKey} is not an updatable provider field (updatable: ${allowed.join(', ')})`);
  }
  if (keys.length === 0) return fail('body', `request body must contain at least one of: ${allowed.join(', ')}`);

  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if ('status' in b) {
    if (!PROVIDER_STATUSES.includes(b.status as ProviderStatus)) return fail('status', `status must be one of ${PROVIDER_STATUSES.join(', ')}`);
    out.status = b.status;
  }
  if ('environment' in b) {
    if (!PROVIDER_ENVIRONMENTS.includes(b.environment as ProviderEnvironment)) return fail('environment', `environment must be one of ${PROVIDER_ENVIRONMENTS.join(', ')}`);
    out.environment = b.environment;
  }

  const numeric: Array<[string, number, number]> = [
    ['weight', 0, 100],
    ['priority', 0, 100],
    ['latencyMin', 0, MAX_LATENCY_MS],
    ['latencyMax', 0, MAX_LATENCY_MS],
    ['transactionFeePercent', 0, 100],
    ['transactionFeeFlat', 0, MAX_FLAT_FEE],
    ['messageCost', 0, MAX_FLAT_FEE],
  ];
  for (const [key, min, max] of numeric) {
    if (!(key in b)) continue;
    const r = numberInRange(b[key], key, min, max);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  if (typeof out.latencyMin === 'number' && typeof out.latencyMax === 'number' && out.latencyMin > out.latencyMax) {
    return fail('latencyMin', 'latencyMin must not be greater than latencyMax');
  }

  const lists: Array<[string, (raw: unknown) => FieldValidation<unknown>]> = [
    ['countries', (raw) => codeList(raw, 'countries', /^[A-Za-z]{2}$/, '["US"]')],
    ['currencies', (raw) => codeList(raw, 'currencies', /^[A-Za-z]{3}$/, '["USD"]')],
    ['capabilities', (raw) => capabilityList(raw, 'capabilities')],
    ['routingRules', (raw) => routingRuleList(raw, 'routingRules')],
  ];
  for (const [key, parse] of lists) {
    if (!(key in b)) continue;
    const r = parse(b[key]);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return ok(out as ProviderManagementUpdate);
}

/**
 * Body of PATCH /api/dashboard/providers/:id — the provider's routing
 * status, weight, simulated latency and fees (the persisted ProviderConfig
 * fields). id/name/category are not updatable.
 */
export function parseProviderConfigUpdate(body: unknown): FieldValidation<ProviderConfigUpdate> {
  return parseProviderUpdate(body, CONFIG_FIELDS);
}

/**
 * Body of PATCH /api/dashboard/providers/:id/management — every persisted,
 * admin-controlled field. Runtime telemetry (health, errorRate,
 * lastSuccessfulRequest, circuit state) is observed from live traffic per
 * process and is not writable.
 */
export function parseProviderManagementUpdate(body: unknown): FieldValidation<ProviderManagementUpdate> {
  return parseProviderUpdate(body, MANAGEMENT_FIELDS);
}
