import { randomUUID, createHash } from 'crypto';
import { ProviderConfig, TransactionEvent, PaymentRequest, MessageRequest, OtherRequest, RefundRequest } from '@company/schemas';

// ---------------------------------------------------------------------------
// Production kill-switch for simulated provider fallbacks (gap register E2).
// ---------------------------------------------------------------------------

/**
 * Base class for "this adapter would have fabricated a simulated result,
 * but simulation is forbidden here" errors. Thrown — never returned as a
 * fake success — so the router treats it as a definite non-charge (nothing
 * was sent to any provider) and the gateway never reports money as moved.
 */
export class SimulatedFallbackBlockedError extends Error {
  readonly code: string;
  readonly providerId: string;
  readonly missing: string[];

  constructor(code: string, providerId: string, missing: string[], message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.providerId = providerId;
    this.missing = missing;
  }
}

/** The adapter has no real credentials (or no real integration at all). */
export class ProviderNotConfiguredError extends SimulatedFallbackBlockedError {
  constructor(providerId: string, missing: string[], detail?: string) {
    super(
      'provider_not_configured',
      providerId,
      missing,
      `Provider '${providerId}' is not configured for real processing` +
        (missing.length ? ` (missing: ${missing.join(', ')})` : '') +
        (detail ? ` — ${detail}` : '') +
        '. Simulated fallback is disabled when NODE_ENV=production.',
    );
  }
}

/** The adapter is configured, but the request lacks an input a real call needs (e.g. paymentToken). */
export class MissingPaymentInputError extends SimulatedFallbackBlockedError {
  constructor(providerId: string, missing: string[]) {
    super(
      'missing_payment_input',
      providerId,
      missing,
      `Provider '${providerId}' cannot make a real call: request is missing ${missing.join(', ')}. ` +
        'Simulated fallback is disabled when NODE_ENV=production.',
    );
  }
}

/** A real money-moving call was attempted without the platform's own transaction id. */
export class MissingPaymentTransactionIdError extends Error {
  readonly code = 'missing_payment_transaction_id';
  constructor() {
    super(
      'paymentTransactionId is required to build a deterministic provider idempotency identity ' +
        '(bis_<payment_transaction_id>_<idempotency_identity>); refusing to call the provider without one.',
    );
    this.name = 'MissingPaymentTransactionIdError';
  }
}

/** Simulated fallbacks are allowed everywhere except NODE_ENV=production (read at call time). */
export function isSimulatedFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// ---------------------------------------------------------------------------
// Deterministic provider idempotency identity (gap register E7 / C11).
// ---------------------------------------------------------------------------

export interface IdempotencyIdentityOptions {
  /** The provider's documented maximum length for the field. Default 255. */
  maxLength?: number;
  /**
   * Characters the provider accepts in the field. Default: ASCII letters,
   * digits, '_' and '-'. A client key containing anything else is replaced
   * by a SHA-256 digest of itself (still deterministic).
   */
  allowedChars?: RegExp;
  /** Separator between the parts. Default '_' (Paystack, which forbids '_', uses '-'). */
  separator?: string;
  /**
   * Distinguishes several provider calls made for ONE payment (e.g.
   * Airwallex create-intent vs confirm-intent need different request ids).
   * Becomes part of the idempotency-identity segment.
   */
  suffix?: string;
}

const DEFAULT_ALLOWED = /^[A-Za-z0-9_-]+$/;
const sha256Hex = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * Builds the provider-facing idempotency identity for one payment:
 *
 *     bis_<payment_transaction_id>_<idempotency_identity>
 *
 * where `<idempotency_identity>` is the client's own Idempotency-Key (or
 * the literal `default` when the client sent none — each keyless request
 * still gets a fresh payment_transaction_id, so the result stays unique per
 * payment), optionally followed by `suffix`.
 *
 * It is a PURE function of (paymentTransactionId, clientKey, options): no
 * Date.now(), no Math.random(), no randomUUID(). The same payment retried —
 * adapter-internal HTTP retry, router failover, or a client retry that
 * reuses the same transaction row — always yields the same identity, and
 * two different payments (different transaction ids) never share one.
 *
 * Fitting provider constraints, deterministically, in this order:
 *  1. A client key with characters the provider rejects is replaced by
 *     `h` + SHA-256(hex) of itself.
 *  2. If the result exceeds `maxLength`, the transaction id is written
 *     without dashes (lossless for a UUID) and the identity segment is
 *     replaced by a SHA-256 digest truncated to the remaining budget
 *     (at least 8 hex chars).
 *  3. If even that cannot fit (very short fields such as Authorize.Net's
 *     20-char refId), the whole thing becomes `bis_` + SHA-256 of
 *     (transaction id, identity), truncated to fit (at least 12 hex chars).
 */
export function buildIdempotencyIdentity(
  paymentTransactionId: string | undefined | null,
  clientKey?: string | null,
  options: IdempotencyIdentityOptions = {},
): string {
  if (typeof paymentTransactionId !== 'string' || paymentTransactionId.trim() === '') {
    throw new MissingPaymentTransactionIdError();
  }
  const maxLength = options.maxLength ?? 255;
  const allowed = options.allowedChars ?? DEFAULT_ALLOWED;
  const sep = options.separator ?? '_';
  const prefix = 'bis';

  const keyPart = typeof clientKey === 'string' && clientKey !== '' ? clientKey : 'default';
  const rawIdentity = options.suffix ? `${keyPart}${sep}${options.suffix}` : keyPart;
  const identity = allowed.test(rawIdentity) ? rawIdentity : `h${sha256Hex(rawIdentity).slice(0, 32)}`;
  const txPart = allowed.test(paymentTransactionId) ? paymentTransactionId : `t${sha256Hex(paymentTransactionId).slice(0, 32)}`;

  const full = [prefix, txPart, identity].join(sep);
  if (full.length <= maxLength) return full;

  const compactTx = txPart.replace(/-/g, '');
  const budget = maxLength - (prefix.length + compactTx.length + 2 * sep.length);
  if (budget >= 8) {
    const digestIdentity = `h${sha256Hex(rawIdentity)}`.slice(0, Math.min(budget, 65));
    return [prefix, compactTx, digestIdentity].join(sep);
  }

  const digestBudget = maxLength - (prefix.length + sep.length);
  if (digestBudget >= 12) {
    return `${prefix}${sep}${sha256Hex(`${paymentTransactionId}\u0000${rawIdentity}`).slice(0, Math.min(digestBudget, 64))}`;
  }
  throw new Error(`buildIdempotencyIdentity: maxLength ${maxLength} is too small for a collision-resistant identity`);
}

/**
 * For providers whose idempotency field must itself be a UUID (PawaPay's
 * `depositId`): a UUID-formatted value derived deterministically from the
 * identity string (first 16 bytes of its SHA-256), with the version nibble
 * set to 4 and the RFC 4122 variant bits set so strict UUIDv4 validators
 * accept it. Same input → same UUID; no randomness.
 */
export function identityToUuid(identity: string): string {
  const bytes = createHash('sha256').update(identity, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Read-only payment status query (Phase 6 — gap register D4 reconciliation).
// ---------------------------------------------------------------------------

export interface PaymentStatusQuery {
  /** The platform's own transactions.id (sent to the provider as metadata/reference). */
  paymentTransactionId: string;
  /** The provider's own id for the payment, when one was ever received. */
  providerTransactionId: string | null;
}

/** What a provider reports about a payment, mapped onto the platform's state machine. */
export type ProviderReportedPaymentStatus = 'success' | 'failed' | 'cancelled' | 'pending' | 'requires_action';

export type PaymentStatusQueryResult =
  /** The adapter has no real, read-only way to ask the provider. */
  | { kind: 'unsupported'; reason: string }
  /** The provider has no record (yet) — NOT evidence of "not charged" (e.g. search-index lag). */
  | { kind: 'not_found'; detail: string }
  /** More than one provider-side payment claims this platform transaction — needs a human. */
  | { kind: 'multiple'; providerTransactionIds: string[] }
  | {
      kind: 'found';
      status: ProviderReportedPaymentStatus;
      providerTransactionId: string;
      /** The provider's own raw status string, for the audit trail. */
      providerStatus: string;
      /** Major units, as reported by the provider (for an amount cross-check). */
      amount?: number;
      currency?: string;
    };

export abstract class BaseProvider {
  public config: ProviderConfig;
  private _secrets: Record<string, string> = {};

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  protected get secrets(): Record<string, string> {
    return this._secrets;
  }

  public setSecrets(secrets: Record<string, string>): void {
    this._secrets = secrets;
  }

  /**
   * Production kill-switch (gap register E2). Every adapter calls this
   * immediately before it would return a simulated/fabricated result.
   * Outside production it is a no-op (dev/test keep simulating without real
   * credentials). With NODE_ENV=production it THROWS instead:
   *   - ProviderNotConfiguredError when `missingCredentials` is non-empty
   *     (or `simulationOnly` is set — an adapter with no real integration);
   *   - MissingPaymentInputError when only request inputs are missing
   *     (e.g. no paymentToken to charge).
   * NODE_ENV is read at call time, not import time.
   */
  protected refuseSimulatedFallbackInProduction(opts: {
    missingCredentials?: string[];
    missingInputs?: string[];
    simulationOnly?: boolean;
    detail?: string;
  }): void {
    if (isSimulatedFallbackAllowed()) return;
    const creds = opts.missingCredentials ?? [];
    const inputs = opts.missingInputs ?? [];
    if (opts.simulationOnly) {
      throw new ProviderNotConfiguredError(this.config.id, creds, opts.detail ?? 'adapter has no real provider integration (simulation only)');
    }
    if (creds.length > 0) {
      throw new ProviderNotConfiguredError(this.config.id, creds, opts.detail);
    }
    throw new MissingPaymentInputError(this.config.id, inputs.length ? inputs : ['required input']);
  }

  /**
   * Deterministic provider idempotency identity for a payment payload —
   * `bis_<payment_transaction_id>_<idempotency_identity>`, see
   * buildIdempotencyIdentity(). Throws MissingPaymentTransactionIdError when
   * the payload carries no paymentTransactionId: a real provider call must
   * never be made with a non-deterministic identity.
   */
  protected paymentIdempotencyIdentity(payload: PaymentRequest, options?: IdempotencyIdentityOptions): string {
    return buildIdempotencyIdentity(payload.paymentTransactionId, payload.idempotencyKey, options);
  }

  /**
   * Make an HTTP request to the provider's API with automatic retry and timeout.
   *
   * Retry strategy:
   * - Retries on 429 (rate limit), 500-599 (server errors), and network errors
   * - Exponential backoff: 500ms → 1s → 2s (capped at 10s)
   * - Respects Retry-After header from 429 responses
   */
  protected async http_request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const {
      method,
      url,
      headers = {},
      body,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
    } = opts;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const fetchOpts: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          signal: controller.signal,
        };

        if (body && method !== 'GET') {
          // Pass pre-serialized string bodies through as-is (e.g. XML for
          // providers that don't speak JSON) — a caller-supplied
          // Content-Type header above already overrides the JSON default.
          fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const res = await fetch(url, fetchOpts);
        clearTimeout(timeout);

        // Parse response
        const contentType = res.headers.get('content-type') || '';
        let responseBody: any;
        if (contentType.includes('application/json')) {
          responseBody = await res.json();
        } else {
          responseBody = await res.text();
        }

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Retry on rate limit or server errors
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = res.headers.get('retry-after');
          const retryMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000);

          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, retryMs));
            continue;
          }
        }

        return {
          status: res.status,
          headers: responseHeaders,
          body: responseBody,
        };
      } catch (err: any) {
        clearTimeout(timeout);
        lastError = err;

        // Don't retry on abort (timeout) for the last attempt
        if (attempt < maxAttempts) {
          const retryMs = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000);
          await new Promise((r) => setTimeout(r, retryMs));
        }
      }
    }

    throw lastError || new Error(`HTTP request failed after ${maxAttempts} attempts`);
  }

  /**
   * Signs a payload using the provider's webhook secret.
   * Used for webhook verification.
   */
  protected async signPayload(payload: string): Promise<string> {
    const { createHmac } = await import('crypto');
    const secret = this.secrets.webhook_secret || this.secrets.api_key || '';
    return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  }

  /**
   * Verifies a webhook signature against the expected signature.
   */
  protected async verifyWebhookSignature(
    rawBody: string,
    signature: string,
    secret?: string,
  ): Promise<boolean> {
    const { createHmac, timingSafeEqual } = await import('crypto');
    const webhookSecret = secret || this.secrets.webhook_secret || '';
    if (!webhookSecret) return false;

    const expected = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Verifies this provider's own native inbound-webhook signature scheme
   * — the real header format and algorithm the provider itself documents
   * (e.g. Stripe's `Stripe-Signature: t=...,v1=...`), not the platform's
   * generic `WEBHOOK_HMAC_SECRET` fallback every provider uses today.
   *
   * Returns:
   *   - `null` — no real per-provider scheme is implemented for this
   *     adapter, OR one is implemented but no webhook secret is
   *     configured for it. The caller (the gateway's webhook route)
   *     should fall back to the generic platform HMAC check.
   *   - `true`/`false` — a real scheme ran and the request did or didn't
   *     pass it. Once a provider's native secret is configured, this is
   *     authoritative — the caller must not additionally fall back to
   *     the generic check on `false` (that would let an attacker bypass
   *     the provider's real protection by supplying a valid platform
   *     signature instead of a valid provider one).
   *
   * Each adapter's override was verified against that provider's real,
   * current documentation (WebSearch, 2026-09-17) before being written —
   * see docs/providers/ADDING_A_PROVIDER.md and each override's own
   * comment for the source. The default here (no override) is honest:
   * this base class has no way to know a provider's real scheme, so it
   * always defers to the platform fallback rather than guessing.
   */
  public async verifyProviderWebhookSignature(
    _rawBody: string,
    _headers: Record<string, string | undefined>,
  ): Promise<boolean | null> {
    return null;
  }

  /**
   * Refunds a previously captured payment. `payload.originalTransactionId`
   * is this adapter's own id for that charge (whatever it returned as
   * TransactionEvent.id when it succeeded — e.g. Stripe's PaymentIntent
   * id) — the caller (services/api-gateway's POST /v1/portal/refunds or
   * /v1/api/gateway/refund route) resolves that from the platform's own
   * `transactions` table, never from client input directly.
   *
   * The default here simulates a successful refund — payment adapters with
   * a real, WebSearch-verified refund API override this to call it for
   * real when credentials are configured, matching the same
   * real-with-simulated-fallback pattern as processRequest(). Adapters
   * that have never had their refund API verified against real
   * documentation keep this simulated default rather than claiming false
   * confidence — see docs/providers/ADDING_A_PROVIDER.md.
   */
  async refund(appId: string, payload: RefundRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();
    // This default IS the simulated path (no provider call at all), so it is
    // subject to the same production kill-switch as simulated charges.
    this.refuseSimulatedFallbackInProduction({
      missingCredentials: this.isConfigured() ? [] : ['credentials'],
      simulationOnly: this.isConfigured(),
      detail: 'this adapter has no real refund API call for its current configuration; the default refund() would fabricate a success',
    });
    const latency = await this.simulateLatency();
    const refundId = 're_' + randomUUID().replace(/-/g, '').slice(0, 24);

    return {
      id: refundId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'payment',
      providerId: this.config.id,
      status: 'success',
      amount: payload.amount,
      currency: payload.currency,
      latency,
      cost: 0,
      decisionReason,
      payload,
      response: {
        id: refundId,
        object: 'refund',
        original_transaction_id: payload.originalTransactionId,
        status: 'succeeded',
      },
    };
  }

  /**
   * Encodes params as application/x-www-form-urlencoded, the body format
   * several payment gateways (Stripe, NMI) require instead of JSON — a
   * JSON body against those APIs is rejected outright, not merely
   * misparsed. One level of nested-object flattening via bracket notation
   * (e.g. { metadata: { appId: 'x' } } -> "metadata[appId]=x"), which is
   * as deep as this platform's provider payloads currently nest. Skips
   * undefined/null values rather than serializing them as the literal
   * strings "undefined"/"null".
   */
  protected toFormBody(params: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          if (nestedValue === undefined || nestedValue === null) continue;
          parts.push(`${encodeURIComponent(key)}[${encodeURIComponent(nestedKey)}]=${encodeURIComponent(String(nestedValue))}`);
        }
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
    }
    return parts.join('&');
  }

  // Simulates provider processing delay (for simulated mode)
  protected async simulateLatency(): Promise<number> {
    const min = this.config.latencyMin;
    const max = this.config.latencyMax;
    const latency = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise((resolve) => setTimeout(resolve, latency));
    return latency;
  }

  // Public wrapper used by health checks to measure current latency.
  public async measureLatency(): Promise<number> {
    return this.simulateLatency();
  }

  // Whether this adapter currently has the real credentials it needs to
  // make a live API call — i.e. the same condition each adapter's
  // processRequest() already checks before falling back to simulated
  // processing (see each adapter's own `if (!this.apiKey ...)` guard).
  // Default true: simulation-only adapters (no real HTTP integration,
  // e.g. SignalHouse/FutureSMS/Email/the example adapters) never need real
  // credentials, so there's nothing to be "unconfigured" about. Adapters
  // with a real HTTP integration override this with their own credential
  // check — see registry.ts's getManagementView() for where this surfaces.
  public isConfigured(): boolean {
    return true;
  }

  /**
   * Phase 8 (shared phone numbers): the account-level sender identity — the
   * number / short code / sender ID — this adapter actually sends FROM,
   * when it is known. The routing layer records it on the conversation as
   * its business number, so a reply arriving on that number can be
   * attributed. undefined = not known (the conversation's number then comes
   * from the owner's messaging profile, or stays unrecorded).
   */
  public getSenderAddress(): string | undefined {
    return this.secrets.from_number || undefined;
  }

  /**
   * Whether this adapter can ask its provider, READ-ONLY, what happened to a
   * payment (used by the reconciliation job for 'unknown'/stuck payments).
   * Default false: as of Phase 6 only Stripe implements one. An adapter must
   * never "answer" this from simulation — no real query, no answer.
   */
  public supportsPaymentStatusQuery(): boolean {
    return false;
  }

  /**
   * Read-only provider status query. MUST NOT create, confirm, capture or
   * otherwise re-send anything that could move money — reconciliation of an
   * ambiguous payment never retries the charge. Default: unsupported.
   * Throws on transport/provider errors (the caller treats that as
   * inconclusive).
   */
  public async queryPaymentStatus(_query: PaymentStatusQuery): Promise<PaymentStatusQueryResult> {
    return { kind: 'unsupported', reason: `'${this.config.id}' adapter has no read-only payment status query` };
  }

  // Checks status, throwing error if not online
  protected verifyAvailability() {
    if (this.config.status === 'offline') {
      throw new Error(`Provider ${this.config.name} is currently OFFLINE`);
    }
    if (this.config.status === 'maintenance') {
      throw new Error(`Provider ${this.config.name} is undergoing MAINTENANCE`);
    }
  }

  abstract processRequest(
    appId: string,
    payload: PaymentRequest | MessageRequest | OtherRequest,
    decisionReason: string
  ): Promise<TransactionEvent>;
}
