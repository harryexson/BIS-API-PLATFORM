import { RoutingRule } from '@company/schemas';

/**
 * The request-side facts a RoutingRule.match expression can reference.
 * Deliberately limited to fields this gateway actually has at routing
 * time — no `bin`/card-range field exists because this platform never
 * collects raw card data (PaymentRequest only ever carries a pre-tokenized
 * `paymentToken`, by design — see docs/DEVELOPER_GUIDE.md §7), so a BIN
 * range condition would have nothing real to match against.
 */
export interface RoutingContext {
  currency?: string;
  amount?: number;
  paymentMethod?: string;
  // Messaging only: 'sms' | 'whatsapp' | 'email', as resolved in routeMessage.
  channel?: string;
}

const NUMERIC_OPS = new Set(['>', '>=', '<', '<=']);
const ALL_OPS = ['>=', '<=', '==', '!=', '>', '<']; // longest-first so '>=' isn't split as '>' + '='

interface Clause {
  field: keyof RoutingContext;
  op: string;
  value: string;
}

const KNOWN_FIELDS = new Set<keyof RoutingContext>(['currency', 'amount', 'paymentMethod', 'channel']);

/**
 * Parses a rule's `match` string, e.g. "currency == USD" or
 * "amount > 100 AND currency == MWK". Returns null (never throws) for
 * anything it can't confidently parse — an admin typo in a routing rule
 * must never crash a request or, worse, silently match everything;
 * failing to parse means the rule simply never fires, logged by the
 * caller.
 */
function parseClauses(match: string): Clause[] | null {
  const parts = match.split(/\s+AND\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const clauses: Clause[] = [];
  for (const part of parts) {
    let matched: { field: string; op: string; value: string } | null = null;
    for (const op of ALL_OPS) {
      const idx = part.indexOf(op);
      if (idx === -1) continue;
      const field = part.slice(0, idx).trim();
      const value = part.slice(idx + op.length).trim();
      if (!field || !value) continue;
      matched = { field, op, value };
      break;
    }
    if (!matched) return null;
    if (!KNOWN_FIELDS.has(matched.field as keyof RoutingContext)) return null;
    clauses.push({ field: matched.field as keyof RoutingContext, op: matched.op, value: matched.value });
  }
  return clauses;
}

function evaluateClause(clause: Clause, ctx: RoutingContext): boolean {
  const actual = ctx[clause.field];
  if (actual === undefined || actual === null) return false;

  if (clause.field === 'amount') {
    const expected = Number(clause.value);
    const actualNum = Number(actual);
    if (Number.isNaN(expected) || Number.isNaN(actualNum)) return false;
    switch (clause.op) {
      case '==': return actualNum === expected;
      case '!=': return actualNum !== expected;
      case '>': return actualNum > expected;
      case '>=': return actualNum >= expected;
      case '<': return actualNum < expected;
      case '<=': return actualNum <= expected;
      default: return false;
    }
  }

  // String fields (currency/paymentMethod/channel): case-insensitive
  // equality only — a numeric comparator on a string field never matches
  // rather than coercing into something misleading.
  if (NUMERIC_OPS.has(clause.op)) return false;
  const actualStr = String(actual).toLowerCase();
  const expectedStr = clause.value.toLowerCase();
  if (clause.op === '==') return actualStr === expectedStr;
  if (clause.op === '!=') return actualStr !== expectedStr;
  return false;
}

/** True if every AND-joined clause in the rule's match expression holds. */
export function evaluateRule(rule: RoutingRule, ctx: RoutingContext): boolean {
  const clauses = parseClauses(rule.match);
  if (!clauses) return false;
  return clauses.every((c) => evaluateClause(c, ctx));
}

/**
 * First enabled rule (in registry iteration order) whose match expression
 * holds for this request — RoutingEngine treats this as an override,
 * taking precedence over capability/score-based selection but never over
 * an explicit providerOverride or (for messaging) active conversation
 * continuity.
 */
export function findMatchingRule(rules: RoutingRule[], ctx: RoutingContext): RoutingRule | undefined {
  return rules.find((rule) => rule.enabled && evaluateRule(rule, ctx));
}
