import { isIP } from 'node:net';

// ----------------------------------------------------
// TRUST PROXY (Phase 23-24, gap register PHASE14-03 / PHASE20-02)
// ----------------------------------------------------
// Every per-IP limit in this gateway (the general/auth rate-limit buckets and
// the Phase 20-21 admin-failure lockout) keys on req.ip. Without Express's
// `trust proxy` setting, req.ip is the TCP peer — behind a reverse proxy or
// load balancer that is the PROXY's address for every caller, so all callers
// share one bucket (one noisy client throttles everyone; 10 bad admin-token
// guesses from anyone lock out every administrator).
//
// The fix is NOT `app.set('trust proxy', true)`: that makes req.ip the
// LEFT-most X-Forwarded-For entry, which the client writes itself — any caller
// could then pick a fresh identity per request (exactly the C14 bypass Phase
// 14 closed) or impersonate an administrator's address to lock them out.
//
// Instead the deployment states its topology explicitly in TRUST_PROXY:
//
//   unset / "" / "false" / "0"   trust nothing (default): req.ip = TCP peer.
//                                Correct when clients connect directly.
//   "<n>"  (1..10)               exactly n proxy hops in front of the gateway
//                                each APPEND the address they received the
//                                request from to X-Forwarded-For; req.ip = the
//                                n-th entry from the RIGHT. Entries to its left
//                                (whatever the client sent) are ignored.
//   "<ip|cidr|name>,..."         trust only peers at these addresses (IPv4/IPv6
//                                address or CIDR, or Express's named ranges
//                                loopback / linklocal / uniquelocal); req.ip is
//                                the right-most X-Forwarded-For entry not in
//                                that set.
//
// Anything else — "true", "*", "all", an unparsable entry — is REFUSED: the
// gateway logs an error and keeps trusting nothing (the pre-existing, shared-
// bucket behaviour), never a guessed or blanket setting.
//
// Railway (the platform the api-gateway is deployed on): one edge proxy hop,
// so the intended value is TRUST_PROXY=1 — see docs/operations/DEPLOYMENT.md
// for why that value still needs one check against the live edge before it is
// relied on.

export type TrustProxySetting = false | number | string[];

export interface TrustProxyConfig {
  /** The value handed to `app.set('trust proxy', ...)`. */
  setting: TrustProxySetting;
  /** Human-readable summary for the startup log. */
  description: string;
  /** Set when TRUST_PROXY was present but refused (setting is then false). */
  error?: string;
}

export const MAX_TRUSTED_HOPS = 10;

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const DISABLED_VALUES = new Set(['', 'false', '0', 'off', 'none']);
const BLANKET_VALUES = new Set(['true', '*', 'all', 'yes', 'on']);

function validEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const slash = entry.indexOf('/');
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(addr);
  if (family === 0) return false;
  if (slash === -1) return true;
  const prefix = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  // A /0 trusts every address on the internet — a blanket `true` in disguise.
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

function refused(raw: string, reason: string): TrustProxyConfig {
  return {
    setting: false,
    description: 'disabled (TRUST_PROXY refused) — req.ip is the TCP peer address',
    error: `TRUST_PROXY=${JSON.stringify(raw)} refused: ${reason}`,
  };
}

export function parseTrustProxy(raw: string | undefined): TrustProxyConfig {
  const value = (raw ?? '').trim();
  const lower = value.toLowerCase();

  if (DISABLED_VALUES.has(lower)) {
    return { setting: false, description: 'disabled — req.ip is the TCP peer address' };
  }
  if (BLANKET_VALUES.has(lower)) {
    return refused(
      value,
      'trusting every hop lets any client choose its own req.ip via X-Forwarded-For; set the exact hop count or proxy address(es)',
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > MAX_TRUSTED_HOPS) {
      return refused(value, `hop count must be between 1 and ${MAX_TRUSTED_HOPS}`);
    }
    return {
      setting: hops,
      description: `${hops} trusted proxy hop(s) — req.ip is X-Forwarded-For entry ${hops} from the right`,
    };
  }

  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  const invalid = entries.filter((e) => !validEntry(e));
  if (entries.length === 0 || invalid.length > 0) {
    return refused(
      value,
      `not a hop count or a list of IP addresses/CIDRs/named ranges (invalid: ${invalid.map((e) => JSON.stringify(e)).join(', ') || 'empty list'})`,
    );
  }
  return {
    setting: entries,
    description: `trusted proxy address(es) ${entries.join(', ')} — req.ip is the right-most X-Forwarded-For entry outside them`,
  };
}
