import { randomUUID, createHash } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ProviderConfig, TransactionEvent, PaymentRequest, MessageRequest, OtherRequest, RefundRequest } from '@company/schemas';

// ---------------------------------------------------------------------------
// Outcome classification for provider calls (Phase 11-12 — gap register
// A10 / E4 / PHASE3-01: the cross-provider double-charge path).
// ---------------------------------------------------------------------------
//
// Every failure of a money-moving provider call is one of exactly two kinds:
//
//  - DEFINITE: the platform KNOWS the provider did not move money — either
//    nothing was ever sent (missing credentials, provider offline, the TCP
//    connection was refused, an auth step before the charge failed), or the
//    provider answered unambiguously that it did not (a decline, a 4xx
//    validation error). Safe for the router to try another provider.
//
//  - AMBIGUOUS: the request may have reached the provider and been processed,
//    but no trustworthy answer came back — a timeout/abort after send, a
//    connection reset, an unparseable body, any 5xx (the provider's own
//    server failed, possibly after processing), or a duplicate-rejection from
//    a retry of an attempt that was itself ambiguous. These become the
//    payment state machine's 'unknown' (Phase 6) and are NEVER retried on a
//    different provider: they are reconciled instead.
//
// `ambiguous` is carried on the error itself so every layer (http_request,
// the adapter's catch block, the router) classifies the same way. An error
// that carries no `ambiguous` flag at all is treated as AMBIGUOUS by the
// router (fail safe: an unclassified failure inside a charge path is "we
// don't know", never "it definitely failed").

/** A provider-call failure that knows whether its outcome is ambiguous. */
export class ProviderCallError extends Error {
  readonly ambiguous: boolean;
  /** The provider's HTTP status, when a response was received. */
  readonly httpStatus?: number;
  /** The call was cancelled by its caller (e.g. the router's timeout) — see http_request. */
  readonly cancelled: boolean;
  /** How many HTTP attempts were actually started. */
  readonly attempts?: number;

  constructor(
    message: string,
    opts: { ambiguous: boolean; httpStatus?: number; cancelled?: boolean; attempts?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'ProviderCallError';
    this.ambiguous = opts.ambiguous;
    this.httpStatus = opts.httpStatus;
    this.cancelled = opts.cancelled ?? false;
    this.attempts = opts.attempts;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** The provider is offline / in maintenance — nothing was sent. Definite. */
export class ProviderUnavailableError extends Error {
  readonly ambiguous = false;
  readonly code = 'provider_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * true unless the error itself says the outcome is definite. Unclassified
 * errors (no boolean `ambiguous` property) are ambiguous — fail safe.
 */
export function isAmbiguousProviderError(err: unknown): boolean {
  const flag = (err as { ambiguous?: unknown } | null | undefined)?.ambiguous;
  return typeof flag === 'boolean' ? flag : true;
}

/**
 * Transport error codes that can only occur BEFORE any byte of the HTTP
 * request reached the provider (name resolution / TCP connect phase). A
 * request that failed this way provably was not processed. Everything else
 * — ECONNRESET, socket hang-up, UND_ERR_SOCKET, a body-read failure, an
 * AbortError — may have happened after the provider received the request.
 */
const PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

function transportErrorCode(err: any): string | undefined {
  return err?.cause?.code ?? err?.code ?? err?.cause?.cause?.code;
}

export function isPreSendTransportError(err: unknown): boolean {
  const code = transportErrorCode(err);
  return typeof code === 'string' && PRE_SEND_ERROR_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Call context — cancellation propagated from the router (gap register E6).
// ---------------------------------------------------------------------------

/** Options the router passes into a provider call. */
export interface ProviderCallOptions {
  /**
   * Aborted when the caller (RoutingEngine's timeout) has given up on this
   * call. http_request aborts the in-flight fetch, stops its retry loop
   * (including a pending backoff sleep), and refuses to START any further
   * request under this signal — so no background charge attempt can fire
   * after the platform has already reported the outcome as 'unknown'.
   */
  signal?: AbortSignal;
}

const providerCallContext = new AsyncLocalStorage<ProviderCallOptions>();

/**
 * Runs `fn` with `options.signal` as the ambient cancellation signal of every
 * BaseProvider.http_request call made anywhere inside it (including from
 * code that forgot to forward the signal explicitly — adapters do not need to
 * thread it by hand, which is how the old version created a signal and never
 * delivered it anywhere).
 */
export function runWithProviderCallOptions<T>(options: ProviderCallOptions, fn: () => Promise<T>): Promise<T> {
  return providerCallContext.run(options, fn);
}

export function currentProviderCallSignal(): AbortSignal | undefined {
  return providerCallContext.getStore()?.signal;
}

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
  /** Thrown before any provider request — a definite non-charge. */
  readonly ambiguous = false;
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
  /** Thrown before any provider request — a definite non-charge. */
  readonly ambiguous = false;
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
  /**
   * Caller cancellation (gap register E6). Defaults to the ambient signal set
   * by runWithProviderCallOptions() — i.e. the router's timeout.
   */
  signal?: AbortSignal;
  /**
   * May an attempt whose outcome is AMBIGUOUS (a 5xx, or a transport failure
   * after the request may have been sent) be retried by this loop?
   *
   * Only safe when the provider deduplicates the retry on an idempotency key
   * it genuinely honours (the retry is then the same logical operation, and
   * the provider replays the original result). For a money-moving call to a
   * provider WITHOUT such a key (NMI, Authorize.Net, Braintree as built, and
   * reference-only providers whose duplicate check answers with an error
   * rather than the original result) a blind retry can charge twice, so those
   * calls set this to false. Failures that provably never reached the
   * provider (DNS/connect-refused) and 429s are always retryable.
   *
   * Default true, preserving the previous behaviour for messaging/other/
   * read-only calls. Every payment charge call in this package sets it
   * explicitly.
   */
  retryAmbiguous?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
  /** Attempts actually started for this request (1 = no retry happened). */
  attempts?: number;
  /**
   * How many EARLIER attempts ended ambiguously (5xx / post-send transport
   * failure) before this response. When > 0, an error response here may be
   * the provider rejecting a duplicate of a request it already processed —
   * see BaseProvider.httpErrorOutcome().
   */
  ambiguousPriorAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

/** Sleeps `ms`, returning early (true) if `signal` aborts first. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReasonText(signal: AbortSignal): string {
  const reason = signal.reason as { message?: unknown } | undefined;
  return typeof reason?.message === 'string' ? reason.message : 'aborted by caller';
}

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
   * Make an HTTP request to the provider's API with bounded timeout and
   * classified retry.
   *
   * Timeout: every attempt is bounded by `timeoutMs` via its own
   * AbortController, covering BOTH the response headers and the body read
   * (the old version cleared the timer as soon as headers arrived, leaving
   * the body read unbounded).
   *
   * Cancellation (gap register E6): `opts.signal` — or, by default, the
   * ambient signal installed by runWithProviderCallOptions() (the router's
   * timeout) — aborts the in-flight fetch, interrupts a pending backoff, and
   * prevents any further attempt from starting. The old version ran up to 3
   * attempts (~91.5s) in the background after the router had already told the
   * client the outcome was 'unknown'.
   *
   * Retry strategy:
   * - 429: retried (the provider rejected it unprocessed), honouring
   *   Retry-After; exponential backoff 500ms → 1s → 2s (capped at 10s).
   * - Transport failures that provably happened before the request was sent
   *   (DNS / connection refused / connect timeout): retried.
   * - AMBIGUOUS failures (5xx, or a transport failure/timeout after the
   *   request may have been sent): retried only when `retryAmbiguous` is not
   *   false — see HttpRequestOptions.retryAmbiguous.
   *
   * Errors: a transport failure is thrown as ProviderCallError whose
   * `ambiguous` says whether ANY attempt may have reached the provider; a
   * cancellation is thrown as ProviderCallError with `cancelled: true`.
   * HTTP error statuses are returned (not thrown) with `attempts` and
   * `ambiguousPriorAttempts` so adapters can classify them.
   */
  protected async http_request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const {
      method,
      url,
      headers = {},
      body,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      retryAmbiguous = true,
    } = opts;
    const signal = opts.signal ?? currentProviderCallSignal();

    let started = 0;
    let ambiguousAttempts = 0;
    const cancelledError = (inFlight: boolean, cause?: unknown) =>
      new ProviderCallError(
        `Provider request cancelled by caller (${signal ? abortReasonText(signal) : 'aborted'}) after ${started} attempt(s)` +
          (inFlight || ambiguousAttempts > 0 ? ' — an attempt may have reached the provider' : ' — no attempt was in flight'),
        { ambiguous: inFlight || ambiguousAttempts > 0, cancelled: true, attempts: started, cause },
      );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Never START a request the caller has already given up on.
      if (signal?.aborted) throw cancelledError(false);

      started++;
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      signal?.addEventListener('abort', onCallerAbort, { once: true });

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

        // Parse response (still under this attempt's timeout).
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

        const ambiguousStatus = res.status >= 500;
        const retryable = res.status === 429 || (ambiguousStatus && retryAmbiguous);
        if (retryable && attempt < maxAttempts) {
          if (ambiguousStatus) ambiguousAttempts++;
          const retryAfter = res.headers.get('retry-after');
          const retryMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000);
          if (await sleepUnlessAborted(retryMs, signal)) throw cancelledError(false);
          continue;
        }

        return {
          status: res.status,
          headers: responseHeaders,
          body: responseBody,
          attempts: started,
          ambiguousPriorAttempts: ambiguousAttempts,
        };
      } catch (err: any) {
        if (err instanceof ProviderCallError) throw err;
        if (signal?.aborted) throw cancelledError(true, err);

        const preSend = isPreSendTransportError(err);
        if (!preSend) ambiguousAttempts++;
        const code = transportErrorCode(err);
        const baseMessage = err?.message || String(err);
        const message = timedOut
          ? `Provider request timed out after ${timeoutMs}ms with no complete response (it may have been processed)`
          : code && !baseMessage.includes(code)
            ? `${baseMessage} (${code}${preSend ? ' — request never sent' : ''})`
            : baseMessage;

        const canRetry = attempt < maxAttempts && (preSend || retryAmbiguous);
        if (!canRetry) {
          throw new ProviderCallError(message, { ambiguous: ambiguousAttempts > 0, attempts: started, cause: err });
        }
        const retryMs = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000);
        if (await sleepUnlessAborted(retryMs, signal)) throw cancelledError(false, err);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onCallerAbort);
      }
    }

    throw new ProviderCallError(`HTTP request failed after ${maxAttempts} attempts`, {
      ambiguous: ambiguousAttempts > 0,
      attempts: started,
    });
  }

  // -------------------------------------------------------------------------
  // Payment outcome classification helpers (Phase 11-12, A10/E4).
  // -------------------------------------------------------------------------

  /** A failure the provider answered unambiguously (or that never reached it). */
  protected definiteFailure(message: string, httpStatus?: number): ProviderCallError {
    return new ProviderCallError(message, { ambiguous: false, httpStatus });
  }

  /** A failure where the provider may have processed the request. */
  protected ambiguousOutcome(message: string, httpStatus?: number): ProviderCallError {
    return new ProviderCallError(message, { ambiguous: true, httpStatus });
  }

  /**
   * Classifies an HTTP error response (status >= 400) from a money-moving call:
   *  - 5xx: the provider's own server failed, possibly after processing → ambiguous.
   *  - 408 (request timeout) / 409 (conflict — e.g. Stripe's
   *    `idempotency_key_in_use` while the original is still executing) →
   *    ambiguous: neither is a decision about the charge.
   *  - ANY error status after an earlier attempt of the same call ended
   *    ambiguously → ambiguous: a retry rejected as a duplicate of a request the
   *    provider already processed looks exactly like a 4xx.
   *  - Any other 4xx (402 decline, 400/422 validation, 401/403 auth, 404, 429)
   *    → definite: the provider received the request and refused it.
   */
  protected httpErrorOutcome(res: HttpResponse, message: string): ProviderCallError {
    const prior = res.ambiguousPriorAttempts ?? 0;
    const ambiguous = res.status >= 500 || res.status === 408 || res.status === 409 || prior > 0;
    return new ProviderCallError(
      ambiguous && prior > 0 && res.status < 500
        ? `${message} (after ${prior} earlier ambiguous attempt(s) — may be a duplicate of an already-processed request)`
        : message,
      { ambiguous, httpStatus: res.status },
    );
  }

  /**
   * The TransactionEvent for a charge attempt that threw. Ambiguous failures
   * become the state machine's 'unknown' (Phase 6), identified by the
   * platform's own pre-allocated transaction id (so the gateway stores
   * provider_transaction_id = NULL rather than a fabricated id) unless a real
   * provider id is already known; definite failures stay 'failed'. The router
   * never retries an 'unknown' on another provider.
   */
  protected paymentFailureEvent(args: {
    appId: string;
    payload: PaymentRequest;
    decisionReason: string;
    err: unknown;
    startTime: number;
    amount: number;
    currency: string;
    idPrefix: string;
    providerTransactionId?: string;
    response?: unknown;
  }): TransactionEvent {
    const ambiguous = isAmbiguousProviderError(args.err);
    const message = (args.err as { message?: string } | null)?.message || String(args.err);
    const id = ambiguous
      ? args.providerTransactionId || args.payload.paymentTransactionId || `${args.idPrefix}unknown_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      : args.idPrefix + randomUUID().replace(/-/g, '').slice(0, 16);
    return {
      id,
      timestamp: new Date().toISOString(),
      appId: args.appId,
      category: 'payment',
      providerId: this.config.id,
      status: ambiguous ? 'unknown' : 'failed',
      amount: args.amount,
      currency: args.currency,
      latency: Date.now() - args.startTime,
      cost: 0,
      decisionReason: ambiguous
        ? `${args.decisionReason} | Ambiguous provider outcome (${message}) — the provider may have processed this charge. Reported as 'unknown'; not retried via another provider; must be reconciled.`
        : args.decisionReason,
      payload: args.payload,
      response: args.response ?? null,
      error: message,
    };
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
      throw new ProviderUnavailableError(`Provider ${this.config.name} is currently OFFLINE`);
    }
    if (this.config.status === 'maintenance') {
      throw new ProviderUnavailableError(`Provider ${this.config.name} is undergoing MAINTENANCE`);
    }
  }

  /**
   * `options.signal` (when given) is the caller's cancellation — adapters do
   * not need to forward it by hand: the router also installs it as the
   * ambient signal for every http_request() made inside this call (see
   * runWithProviderCallOptions), so it reaches the HTTP layer either way.
   */
  abstract processRequest(
    appId: string,
    payload: PaymentRequest | MessageRequest | OtherRequest,
    decisionReason: string,
    options?: ProviderCallOptions,
  ): Promise<TransactionEvent>;
}
