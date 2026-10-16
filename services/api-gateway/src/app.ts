import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine, ConsentBlockedError } from '@company/routing';
import { EventBus, WebhookDelivery } from '@company/events';
import { TransactionEvent, TransactionStatusResponse, ProviderCapabilityMatch } from '@company/schemas';
import { AuthService, createMiddleware } from './auth';
import {
  TenantRegistry,
  tenantRepository,
  tenantApplicationLinkRepository,
  applicationRepository,
  eventRepository,
  transactionRepository,
  userRepository,
  apiKeyRepository,
  checkoutSessionRepository,
  hashPassword,
  verifyPassword,
  generateApiKey,
  checkDatabaseHealth,
  consentRecordRepository,
  messagingProfileRepository,
  webhookEndpointRepository,
  ApplicationRegistry,
  AuthRegistry,
  AuthError,
  ValidationError,
  ConflictError,
  userSessionRepository,
  userVerificationTokenRepository,
  roleRepository,
  type PublicUser,
  SubscriptionRegistry,
  SubscriptionError,
  planRepository,
  subscriptionRepository,
  CrmRegistry,
  CrmError,
  customerNoteRepository,
  supportTicketRepository,
  ticketCommentRepository,
  ensureProviderRow,
  persistProviderSecrets,
  loadAllProviderSecrets,
  webhookEventRepository,
  outboxEventRepository,
  paymentOutcomeFromEvent,
  supplierRepository,
  SupplierScope,
  inboundMessageHoldRepository,
  type InboundMessageHold,
  keywordCommandRepository,
  keywordCommandDispatchRepository,
  KeywordCommandValidationError,
  RESERVED_KEYWORD_NAMES,
  type KeywordCommand,
  type KeywordCommandDispatch,
} from '@company/database';
import {
  logger,
  metrics,
  runWithContext,
  getContext,
  setContextField,
} from '@company/observability';
import {
  PlatformIdempotencyService,
  computeRequestHash,
  type IdempotencyClaim,
  sendTransactionalEmail,
  verificationEmailHtml,
  passwordResetEmailHtml,
} from '@company/shared';
import {
  createStore,
  createKeys,
  createWorkerConfig,
  JobQueue,
  ingestWebhook,
  runDurableWebhookConsumer,
  WebhookConsumerBusyError,
  type KVStore,
  type Keys,
  type WorkerConfig,
} from '@company/workers';
import { signPortalToken, verifyPortalToken, PortalTokenPayload } from './jwt';

const platformIdempotency = new PlatformIdempotencyService();

// How long a request whose Idempotency-Key is held by an IDENTICAL in-flight
// request waits for that request to finish (and then returns its result)
// before answering 409 idempotency_in_progress. Covers double-submits.
const IDEMPOTENCY_WAIT_MS = Number(process.env.IDEMPOTENCY_WAIT_MS ?? 10_000);

/**
 * Claim an Idempotency-Key, failing CLOSED: if the idempotency store errors
 * (DB down, etc.) the operation is refused with 503 and nothing is charged,
 * because idempotency can't be guaranteed. Returns null when a response has
 * already been sent.
 */
async function claimIdempotencyKeyOrRespond(
  res: Response,
  appId: string,
  tenantId: string,
  operation: 'payment' | 'refund',
  idempotencyKey: string,
  requestHash: string,
): Promise<IdempotencyClaim | null> {
  try {
    return await platformIdempotency.checkAndClaim(appId, tenantId, operation, idempotencyKey, requestHash, {
      waitForInFlightMs: IDEMPOTENCY_WAIT_MS,
    });
  } catch (err) {
    logger.error('idempotency claim failed', {
      operation: `${operation}-idempotency-claim`,
      applicationId: appId,
      errorCode: 'IDEMPOTENCY_STORE_UNAVAILABLE',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      error: {
        code: 'idempotency_unavailable',
        message: `Could not verify the Idempotency-Key, so the ${operation} was NOT attempted. Retry with the same key.`,
      },
    });
    return null;
  }
}

/** Logs (instead of silently dropping) a failure to finalise an idempotency record. */
function logIdempotencyFinaliseError(recordId: string, step: 'complete' | 'fail') {
  return (err: unknown) => {
    logger.error(`idempotency ${step} failed`, {
      operation: `idempotency-${step}`,
      errorCode: 'IDEMPOTENCY_FINALISE_FAILED',
      status: 'failed',
      recordId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  };
}

// ----------------------------------------------------
// Payment request fields beyond amount/currency/method (gap register C1/E1)
// ----------------------------------------------------

const MAX_PAYMENT_TOKEN_LENGTH = 1024;
const MAX_PAYMENT_METADATA_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

interface PaymentExtras {
  paymentToken?: string;
  country?: string;
  metadata?: Record<string, unknown>;
}

type FieldValidation<T> = { ok: true; value: T } | { ok: false; field: string; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Validates the request fields the public payment/checkout routes used to
 * silently DROP before calling the routing engine — which made every card
 * adapter's "no token → simulated success" fallback fire on every real call.
 *   paymentToken: optional; if present a non-empty string (provider-issued
 *                 token/nonce — never raw card data), ≤ 1024 chars.
 *   country:      optional; if present an ISO 3166-1 alpha-2 code
 *                 (normalised to upper case).
 *   metadata:     optional; if present a plain JSON object ≤ 16 KiB.
 */
function parsePaymentExtras(body: Record<string, unknown> | undefined): FieldValidation<PaymentExtras> {
  const value: PaymentExtras = {};
  const { paymentToken, country, metadata } = body ?? {};

  if (paymentToken !== undefined && paymentToken !== null) {
    if (typeof paymentToken !== 'string' || paymentToken.trim() === '') {
      return { ok: false, field: 'paymentToken', message: 'paymentToken must be a non-empty string when provided' };
    }
    if (paymentToken.length > MAX_PAYMENT_TOKEN_LENGTH) {
      return { ok: false, field: 'paymentToken', message: `paymentToken must be at most ${MAX_PAYMENT_TOKEN_LENGTH} characters` };
    }
    value.paymentToken = paymentToken.trim();
  }

  if (country !== undefined && country !== null) {
    if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)) {
      return { ok: false, field: 'country', message: 'country must be a 2-letter ISO 3166-1 alpha-2 code when provided' };
    }
    value.country = country.toUpperCase();
  }

  if (metadata !== undefined && metadata !== null) {
    if (!isPlainObject(metadata)) {
      return { ok: false, field: 'metadata', message: 'metadata must be a JSON object when provided' };
    }
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_PAYMENT_METADATA_BYTES) {
      return { ok: false, field: 'metadata', message: `metadata must serialize to at most ${MAX_PAYMENT_METADATA_BYTES} bytes` };
    }
    value.metadata = metadata;
  }

  return { ok: true, value };
}

function invalidRequest(res: Response, field: string, message: string) {
  return res.status(400).json({ error: { code: 'invalid_request', field, message } });
}

// ----------------------------------------------------
// Authenticated request identity (Phase 7 — multi-tenant hard boundary)
// ----------------------------------------------------
// The ONLY source of application / tenant / supplier identity for a
// tenant-scoped request. Populated by mw.apiKey (application, from the API
// key) and resolveTenantContext (tenant: x-tenant-id verified against an
// ACTIVE tenant_application_links row; supplier: x-supplier-id verified
// through the full Application → Tenant → Supplier chain). Route handlers
// read identity from here — never from req.body, and never from a raw header.
interface GatewayAuthContext {
  /** The application's slug, from the API key. */
  appId: string;
  /** The application's UUID (applications.id). */
  applicationUuid: string;
  /** The verified tenant (x-tenant-id, link-checked). */
  tenantId: string;
  /** The verified supplier (x-supplier-id, ownership-chain-checked), if the request named one. */
  supplierId?: string;
}

type GatewayRequest = Request & { appId?: string; gatewayAuth?: GatewayAuthContext };

/** Attribution value used in logs/audit for anything the gateway has not verified. */
const UNVERIFIED_IDENTITY = 'unknown';

/**
 * Top-level request-body fields that name an identity. They are removed from
 * every tenant-scoped request body before any handler runs, so no handler —
 * present or future — can read a caller-chosen identity out of the body: the
 * spec's "NEVER trust tenantId, applicationId, supplierId, or ownership
 * fields supplied only in the request body". (`appId` was already overwritten
 * with the API key's application by mw.apiKey; it is listed for completeness.)
 */
const BODY_IDENTITY_FIELDS = [
  'tenantId', 'tenant_id', 'tenant',
  'supplierId', 'supplier_id', 'supplier',
  'applicationId', 'application_id',
] as const;

function stripBodyIdentityFields(req: Request): string[] {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const stripped: string[] = [];
  for (const field of BODY_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      delete (body as Record<string, unknown>)[field];
      stripped.push(field);
    }
  }
  return stripped;
}

/**
 * The verified identity of a tenant-scoped request. Throws if called on a
 * route that is not behind mw.apiKey + resolveTenantContext — a programming
 * error that must fail loudly (500), never fall back to a default tenant.
 */
function authContext(req: Request): GatewayAuthContext {
  const ctx = (req as GatewayRequest).gatewayAuth;
  if (!ctx) throw new Error('authContext() used on a route without verified tenant context');
  return ctx;
}

/** Stamps the verified tenant (and supplier) onto an event before it is emitted. */
function scopeEvent<T extends TransactionEvent>(event: T, scope: { tenantId: string; supplierId?: string }): T {
  return {
    ...event,
    tenantId: scope.tenantId,
    ...(scope.supplierId ? { supplierId: scope.supplierId } : {}),
  };
}

type PaymentTransactionRow = NonNullable<Awaited<ReturnType<typeof transactionRepository.findById>>>;

type PaymentAllocation =
  | { kind: 'allocated'; transaction: PaymentTransactionRow; reopened: boolean }
  | { kind: 'conflict'; existing: PaymentTransactionRow };

/**
 * Allocates the platform's own `transactions` row for a payment BEFORE any
 * provider is called (gap register E7 root cause / D5). Its id is the
 * `payment_transaction_id` every adapter's deterministic provider
 * idempotency identity is built from (bis_<payment_transaction_id>_<key>).
 *
 * With an Idempotency-Key (the transactions table keeps keyed payments
 * forever under idx_transactions_idempotency, while an idempotency claim
 * only lives for its TTL):
 *   - no prior row          → a new row in status 'processing';
 *   - prior row 'failed' with NO provider transaction id (the earlier
 *     attempt never got any provider result — routing threw) → that SAME
 *     row is atomically reopened, so the retry reuses the same
 *     payment_transaction_id and therefore sends the provider the same
 *     idempotency identity (if the earlier attempt did reach the provider,
 *     the provider deduplicates instead of charging twice);
 *   - any other prior row   → conflict (charging again could move money a
 *     second time). This is the Phase-2 "key already produced a
 *     transaction" guard, now applied at allocation time.
 * A concurrent insert that loses the race on the unique index is also a
 * conflict. Throws only on database errors (callers fail closed: the
 * provider is never called without a durable payment record).
 */
async function allocatePaymentTransaction(input: {
  appId: string;
  tenantId: string;
  amount: string;
  currency: string;
  paymentMethod?: string | null;
  idempotencyKey?: string | null;
  providerId?: string | null;
  metadata?: unknown;
}): Promise<PaymentAllocation> {
  const key = input.idempotencyKey || null;
  if (key) {
    const existing = await transactionRepository.findByAppAndIdempotencyKey(input.appId, input.tenantId, key);
    if (existing) {
      if (existing.status === 'failed' && !existing.providerTransactionId) {
        const reopened = await transactionRepository.reopenFailedPaymentAttempt(existing.id);
        if (reopened) return { kind: 'allocated', transaction: reopened, reopened: true };
      }
      return { kind: 'conflict', existing };
    }
  }

  const created = await transactionRepository.allocatePaymentAttempt({ ...input, idempotencyKey: key });
  if (created) return { kind: 'allocated', transaction: created, reopened: false };

  // Lost the race on idx_transactions_idempotency to a concurrent request.
  const winner = key ? await transactionRepository.findByAppAndIdempotencyKey(input.appId, input.tenantId, key) : undefined;
  if (!winner) throw new Error('payment transaction allocation conflicted but no existing row was found');
  return { kind: 'conflict', existing: winner };
}

/**
 * Records the provider outcome on the pre-allocated row. Logs (never throws): the money has already moved or not.
 *
 * Phase 6 (gap register D4): an ambiguous outcome ('unknown' — e.g. the
 * router's provider timeout) is stored as the distinct 'unknown' status
 * (it used to be collapsed into 'pending'), on the row's own stable id, with
 * provider_transaction_id left NULL unless the provider actually returned an
 * id (it used to be a throwaway randomUUID() nothing could ever match). See
 * paymentOutcomeFromEvent. Such a row is never re-attempted as a new charge:
 * a same-key retry gets 409 (allocatePaymentTransaction never reopens it),
 * and it is resolved only by the provider's webhook, the reconciliation
 * job's read-only status check, or an operator.
 */
async function recordPaymentOutcome(paymentTransactionId: string, event: TransactionEvent, fallbackCurrency: string) {
  try {
    const updated = await transactionRepository.recordPaymentAttemptOutcome(
      paymentTransactionId,
      paymentOutcomeFromEvent(paymentTransactionId, event, fallbackCurrency),
    );
    if (!updated) {
      logger.error('payment outcome not recorded: transaction row was not in processing state', {
        operation: 'payment-record-outcome',
        errorCode: 'PAYMENT_OUTCOME_NOT_RECORDED',
        status: 'failed',
        paymentTransactionId,
        providerTransactionId: event.id,
      });
    }
  } catch (err) {
    // The row stays 'processing' — a durable, reconcilable "outcome not
    // recorded" marker, rather than (as before this phase) no row at all.
    logger.error('payment outcome write failed', {
      operation: 'payment-record-outcome',
      errorCode: 'PAYMENT_OUTCOME_WRITE_FAILED',
      status: 'failed',
      paymentTransactionId,
      providerTransactionId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Routing threw (no provider produced a result): mark the attempt failed so a same-key retry can reopen it. */
async function recordPaymentRoutingFailure(
  paymentTransactionId: string,
  providerId: string,
  error: string,
  baseMetadata: Record<string, unknown> | null | undefined,
) {
  try {
    await transactionRepository.recordPaymentAttemptOutcome(paymentTransactionId, {
      providerId,
      providerTransactionId: null,
      status: 'failed',
      metadata: { ...(baseMetadata ?? {}), bisFailure: { stage: 'routing', error } },
    });
  } catch (err) {
    logger.error('payment routing-failure write failed', {
      operation: 'payment-record-outcome',
      errorCode: 'PAYMENT_OUTCOME_WRITE_FAILED',
      status: 'failed',
      paymentTransactionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function paymentConflictResource(prior: PaymentTransactionRow) {
  return {
    id: prior.providerTransactionId,
    paymentTransactionId: prior.id,
    status: prior.status,
    amount: Number(prior.amount),
    currency: prior.currency,
    providerId: prior.providerId,
  };
}

const app = express();

// P1-1: Restrict CORS to configured origins
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];
app.use(
  cors(
    allowedOrigins.length > 0
      ? {
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(new Error('Not allowed by CORS'));
            }
          },
          credentials: true,
        }
      : { origin: '*' },
  ),
);

// P1: Security headers — prevent common web vulnerabilities
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// P1-3: Explicit body size limit
// `verify` stashes the raw request bytes on req.rawBody alongside the
// parsed JSON — needed by the Stripe billing webhook route below, whose
// signature verification is computed over the exact raw body, not a
// re-serialized JSON.stringify(req.body) (which can differ in key order/
// whitespace and would break the signature).
app.use(express.json({
  limit: '100kb',
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));

// ----------------------------------------------------
// P3-1: REQUEST/RESPONSE LOGGING + TRACING
// ----------------------------------------------------
// Logs sanitized request details at start, response summary at finish.
// Adds X-Request-Id to all responses for distributed tracing.
// Never logs secrets or PII — the logger redacts sensitive fields by default.
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  const correlationId = (req.header('x-correlation-id') as string) || requestId;
  const ctx = {
    requestId,
    correlationId,
    operation: `${req.method} ${req.path}`,
  };

  runWithContext(ctx, () => {
    // Log request start (debug level — noisy in production, useful in dev)
    const bodySummary = req.body && Object.keys(req.body).length > 0
      ? { fields: Object.keys(req.body), size: JSON.stringify(req.body).length }
      : undefined;
    logger.debug('request received', {
      method: req.method,
      path: req.path,
      query: Object.keys(req.query).length > 0 ? req.query : undefined,
      body: bodySummary,
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });

    // Attach tracing header to response
    res.setHeader('X-Request-Id', requestId);

    const start = Date.now();
    res.on('finish', () => {
      const c = getContext();
      // Phase 7 (gap register GW-1.4): log/audit attribution comes ONLY from
      // identity the gateway itself verified — the API key's application
      // (mw.apiKey) and the x-tenant-id / x-supplier-id that
      // resolveTenantContext checked against tenant_application_links and
      // the supplier ownership chain. It used to fall back to
      // `req.body.tenantId` / `req.body.supplierId` (and to the raw,
      // unverified headers), so an unauthenticated or rejected request could
      // write any tenant/supplier it liked into the platform's logs. Anything
      // unverified is recorded as the explicit 'unknown'; the raw header a
      // REJECTED request claimed is kept only under a clearly-unverified
      // field name (bounded), for forensics — never as tenantId.
      const verified = (req as GatewayRequest).gatewayAuth;
      const applicationId = verified?.appId ?? c.applicationId ?? UNVERIFIED_IDENTITY;
      const tenantId = verified?.tenantId ?? UNVERIFIED_IDENTITY;
      const supplierId = verified?.supplierId ?? (req.header('x-supplier-id') ? UNVERIFIED_IDENTITY : undefined);
      setContextField('applicationId', applicationId);
      setContextField('tenantId', tenantId);
      if (supplierId) setContextField('supplierId', supplierId);

      const latency = Date.now() - start;
      const status = res.statusCode;

      const logFields: Record<string, any> = {
        method: req.method,
        path: req.path,
        status,
        latency,
        providerId: c.providerId,
        applicationId,
        tenantId,
        ...(supplierId ? { supplierId } : {}),
      };
      if (!verified) {
        const claimedTenant = req.header('x-tenant-id');
        if (claimedTenant) logFields.unverifiedTenantHeader = claimedTenant.slice(0, 64);
      }

      if (status >= 500) {
        logger.error('request failed', logFields);
        metrics.increment('apiErrors');
      } else if (status >= 400) {
        logger.warn('request rejected', logFields);
      } else {
        logger.info('request completed', logFields);
      }

      metrics.recordLatency(latency);
    });
    next();
  });
});

// Records a gateway operation against the observability metrics + logs it.
function observe(event: TransactionEvent) {
  recordTrafficResult(event.providerId, event.status, event.latency);
  setContextField('providerId', event.providerId);
  setContextField('applicationId', event.appId);

  const success = event.status === 'success';
  if (event.category === 'payment') {
    metrics.increment(success ? 'paymentSuccess' : 'paymentFailure');
  } else if (event.category === 'messaging') {
    metrics.increment(success ? 'messageSuccess' : 'messageFailure');
  }

  logger.info('gateway operation completed', {
    operation: event.category,
    providerId: event.providerId,
    status: event.status,
    latency: event.latency,
    errorCode: success ? undefined : 'OPERATION_FAILED',
  });
}

function observeFailure(category: 'payment' | 'messaging' | 'other', providerId: string, errorCode: string) {
  metrics.increment('routingFailures');
  logger.error('gateway operation failed', {
    operation: category,
    providerId,
    errorCode,
    status: 'failed',
  });
}

const auth = new AuthService({
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },
});
const mw = createMiddleware(auth);

app.use('/v1/api', mw.rateLimit);
// P0: Rate-limit admin endpoints to prevent brute-force attacks
app.use('/api/dashboard', mw.rateLimit);
app.use('/api/observability', mw.rateLimit);

// P1-1: Request timeout middleware — prevents hung provider calls from holding connections.
// A payment timeout must not automatically mean retry; ambiguous outcomes are reconciled via webhook.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 60_000;
app.use('/v1/api/gateway/*', (req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timed out' });
    }
  }, REQUEST_TIMEOUT_MS);
  res.on('finish', () => clearTimeout(timeout));
  next();
});

const registry = ProviderRegistry.getInstance();
const routingEngine = new RoutingEngine();
const eventBus = EventBus.getInstance();

// P0: Outbound platform webhooks — every event this gateway emits is
// delivered to the active, subscribed webhook_endpoints rows of that
// event's OWN (appId, tenantId), signed with each endpoint's own secret.
// Backs the POST/GET/DELETE /v1/api/gateway/webhooks registration routes.
//
// Phase 7 (gap register C4 / GW-1.5): this used to fan every event out to
// every endpoint of the event's appId — TransactionEvent had no tenantId —
// so in a shared application (many churches under one Reach Church
// registration, many hosts under one STAYSCAPE registration) tenant B's
// endpoint received tenant A's full payment/message payload, including the
// payment id that the (then app-only) refund route accepted. Now:
//   - an event with no tenantId is delivered to NO endpoint (fail closed —
//     logged, counted), instead of to every tenant;
//   - endpoints are selected by (appId, tenantId) in SQL, and re-checked
//     here row by row before anything is enqueued.
const webhookDelivery = new WebhookDelivery();
webhookDelivery.start();

async function dispatchOutboundWebhooks(event: TransactionEvent): Promise<void> {
  if (!event.appId) return;
  if (!event.tenantId) {
    metrics.increment('webhookDispatchUnscoped');
    logger.warn('outbound webhook not dispatched: event carries no verified tenant', {
      operation: 'webhook-dispatch',
      errorCode: 'EVENT_TENANT_UNKNOWN',
      status: 'skipped',
      applicationId: event.appId,
      eventCategory: event.category,
    });
    return;
  }
  let endpoints;
  try {
    endpoints = await webhookEndpointRepository.findActiveByAppAndTenant(event.appId, event.tenantId);
  } catch {
    // No DB configured (e.g. some simulation/test contexts) — nothing to
    // dispatch to; never let this block the event that triggered it.
    return;
  }
  if (endpoints.length === 0) return;

  for (const endpoint of endpoints) {
    // Defense in depth: never deliver across the (app, tenant) boundary even
    // if a repository/query bug returned a foreign row.
    if (endpoint.appId !== event.appId || endpoint.tenantId !== event.tenantId) {
      logger.error('outbound webhook endpoint outside the event scope — refused', {
        operation: 'webhook-dispatch',
        errorCode: 'CROSS_TENANT_DISPATCH_REFUSED',
        status: 'failed',
        applicationId: event.appId,
      });
      continue;
    }
    const eventTypes = Array.isArray(endpoint.eventTypes) ? (endpoint.eventTypes as string[]) : ['*'];
    // Phase 9: an endpoint may also subscribe to one message type within a
    // category, e.g. 'messaging.keyword_command' (app-specific keyword
    // commands only) instead of every 'messaging' event.
    const subtype = event.messageType ? `${event.category}.${event.messageType}` : null;
    if (!eventTypes.includes('*') && !eventTypes.includes(event.category) && !(subtype && eventTypes.includes(subtype))) continue;

    let secret: string | undefined;
    try {
      secret = webhookEndpointRepository.resolveSecret(endpoint);
    } catch {
      logger.error('failed to decrypt webhook endpoint secret — skipping delivery', {
        operation: 'webhook-dispatch',
        errorCode: 'SECRET_DECRYPT_FAILED',
        status: 'failed',
      });
      continue;
    }
    // Namespaced by endpoint + event id: the same event can fan out to
    // several endpoints, each tracked as its own independent delivery.
    webhookDelivery.enqueue(`${endpoint.id}:${event.id}`, { url: endpoint.url, secret }, event);
  }
}

eventBus.subscribe((event) => {
  dispatchOutboundWebhooks(event).catch(() => {
    logger.error('outbound webhook dispatch failed', {
      operation: 'webhook-dispatch',
      errorCode: 'DISPATCH_FAILED',
      status: 'failed',
    });
  });
});

// P0: Provider secrets added through the admin console previously lived
// only in ProviderRegistry's in-memory Map — a secret survived until the
// next restart, then silently reverted to whatever the process.env
// fallback provided (or nothing). Read back every already-persisted
// provider's secrets into the registry once at startup, and persist the
// full current set after every admin add/delete (see the
// /api/dashboard/providers/:id/secrets routes below).
//
// Fire-and-forget and non-blocking — server startup must not wait on a DB
// round trip, and a provider with no persisted secrets yet (or
// SECRET_ENCRYPTION_KEY unset, e.g. most non-production environments) is
// expected, not an error: the adapter's process.env fallback still works
// exactly as before this existed.
async function hydrateProviderSecretsFromDb(): Promise<void> {
  try {
    const snapshot = await loadAllProviderSecrets();
    for (const [slug, secrets] of Object.entries(snapshot)) {
      registry.hydrateSecrets(slug, secrets);
    }
  } catch (err) {
    logger.warn('provider secrets hydration failed — adapters still work via env-var fallback', {
      operation: 'startup',
      errorCode: 'PROVIDER_SECRETS_HYDRATE_FAILED',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
void hydrateProviderSecretsFromDb();

// Encrypts and stores the provider's full current secrets set — called
// fire-and-forget after every successful addSecret()/deleteSecret() below.
// Never blocks or fails the HTTP response: the in-memory registry (what
// every real adapter call actually reads) is already correct the moment
// addSecret()/deleteSecret() returns; this only affects whether that state
// survives the *next* restart, not the current request.
function persistProviderSecretsAsync(id: string): void {
  const secrets = registry.exportSecretsForPersistence(id);
  if (secrets === null) return;
  const config = registry.getAllConfigs().find((c) => c.id === id);
  if (!config) return;

  (async () => {
    await ensureProviderRow({ slug: id, name: config.name, category: config.category });
    await persistProviderSecrets(id, secrets);
  })().catch((err) => {
    logger.warn('provider secrets persistence failed — in-memory state is still correct', {
      operation: 'provider_secrets_persist',
      providerId: id,
      errorCode: 'PROVIDER_SECRETS_PERSIST_FAILED',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ----------------------------------------------------
// P0-4: TENANT ISOLATION MIDDLEWARE (ENFORCED)
// ----------------------------------------------------
// Tenant context is MANDATORY for all /v1/api/gateway/* routes.
// Requests without x-tenant-id are rejected — tenant is never advisory.
// Prevents cross-tenant access via IDOR.
//
// Phase 7: on success this records the VERIFIED identity on
// req.gatewayAuth (see GatewayAuthContext) — the only place route handlers
// read application/tenant/supplier identity from — and strips identity
// fields out of the request body so no handler can read a caller-chosen
// tenant/supplier/application from it. An optional x-supplier-id is
// verified through the full Application → Tenant → Supplier chain
// (SupplierScope); a supplier the authenticated tenant does not own is a 403.
const supplierScope = new SupplierScope(applicationRepository, tenantApplicationLinkRepository, supplierRepository);

const MAX_TENANT_ID_LENGTH = 255;

async function resolveTenantContext(req: Request, res: Response, next: NextFunction) {
  const authed = req as GatewayRequest;
  // Fail closed: this middleware is only ever mounted after mw.apiKey, which
  // always sets appId on success. No appId means no authenticated
  // application — never "skip tenant checks".
  if (!authed.appId) return res.status(401).json({ error: 'Unauthorized' });

  const tenantId = req.header('x-tenant-id');
  if (!tenantId) {
    logger.warn('tenant context missing', {
      operation: 'tenant-resolution',
      errorCode: 'TENANT_REQUIRED',
      status: 'failed',
    });
    return res.status(400).json({ error: 'x-tenant-id header is required' });
  }
  if (tenantId.length > MAX_TENANT_ID_LENGTH) {
    return res.status(403).json({ error: 'Access denied: tenant not linked to this application' });
  }

  let applicationUuid: string;
  try {
    // authed.appId is the application's slug (used consistently as the
    // human-readable app identifier across transactions/conversations/events),
    // but tenant_application_links.application_id is a UUID FK to
    // applications.id. Resolve slug -> UUID before checking the link,
    // otherwise this always fails against a real database.
    const application = await applicationRepository.findBySlug(authed.appId);
    if (!application) {
      logger.warn('tenant access denied: application not found', {
        operation: 'tenant-resolution',
        errorCode: 'APPLICATION_NOT_FOUND',
        status: 'failed',
      });
      return res.status(403).json({ error: 'Access denied: tenant not linked to this application' });
    }
    const tenantRegistry = new TenantRegistry(tenantRepository, tenantApplicationLinkRepository);
    await tenantRegistry.assertTenantAccess(application.id, tenantId);
    applicationUuid = application.id;
  } catch {
    logger.warn('tenant access denied', {
      operation: 'tenant-resolution',
      errorCode: 'TENANT_ACCESS_DENIED',
      status: 'failed',
    });
    return res.status(403).json({ error: 'Access denied: tenant not linked to this application' });
  }

  const ctx: GatewayAuthContext = { appId: authed.appId, applicationUuid, tenantId };

  // Optional supplier scope (Afribook vendors, STAYSCAPE hosts): verified
  // hop by hop against the platform's rows, starting from the AUTHENTICATED
  // application and tenant — never from anything in the body.
  const supplierHeader = req.header('x-supplier-id');
  if (supplierHeader !== undefined) {
    let supplier: Awaited<ReturnType<typeof supplierScope.resolveOwnedSupplier>>;
    try {
      supplier = await supplierScope.resolveOwnedSupplier({ appSlug: ctx.appId, tenantId: ctx.tenantId, supplierRef: supplierHeader });
    } catch {
      supplier = null; // fail closed on a lookup error
    }
    if (!supplier) {
      logger.warn('supplier access denied', {
        operation: 'supplier-resolution',
        errorCode: 'SUPPLIER_ACCESS_DENIED',
        status: 'failed',
        applicationId: ctx.appId,
        tenantId: ctx.tenantId,
      });
      return res.status(403).json({ error: 'Access denied: supplier not owned by this tenant' });
    }
    ctx.supplierId = supplier.id;
  }

  const stripped = stripBodyIdentityFields(req);
  if (stripped.length > 0) {
    logger.warn('request-body identity fields ignored — identity comes only from the authenticated context', {
      operation: 'tenant-resolution',
      errorCode: 'BODY_IDENTITY_IGNORED',
      status: 'ignored',
      applicationId: ctx.appId,
      tenantId: ctx.tenantId,
      fields: stripped,
    });
  }

  authed.gatewayAuth = ctx;
  setContextField('applicationId', ctx.appId);
  setContextField('tenantId', ctx.tenantId);
  if (ctx.supplierId) setContextField('supplierId', ctx.supplierId);
  return next();
}

// ----------------------------------------------------
// ADMIN AUTHORIZATION
// ----------------------------------------------------
// Mutating provider-management endpoints require an admin token.
// Token is provided via the `x-admin-token` header.
// In production, ADMIN_API_TOKEN must be explicitly set.
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const isProduction = process.env.NODE_ENV === 'production';
if (!ADMIN_API_TOKEN && isProduction) {
  logger.error('ADMIN_API_TOKEN is not set in production — admin endpoints are INSECURE', {
    operation: 'startup',
    errorCode: 'MISSING_ADMIN_TOKEN',
    status: 'failed',
  });
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // EventSource (used for /api/dashboard/stream) can't set custom headers, so
  // that one route needs a query-param fallback — the standard pattern for
  // authenticating SSE connections in browsers.
  const token = req.header('x-admin-token') || (req.query.token as string | undefined);
  if (!ADMIN_API_TOKEN) {
    // P0: Never bypass admin auth — require token in ALL environments
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  if (!token || token !== ADMIN_API_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: administrator authorization required' });
  }
  return next();
}

// ----------------------------------------------------
// DEVELOPER PORTAL AUTHORIZATION
// ----------------------------------------------------
// Per-user JWT session auth for the developer portal (apps/developer-portal),
// distinct from the API-key auth used by server-to-server traffic routes and
// the shared-passcode admin auth above. In production PORTAL_JWT_SECRET must
// be explicitly set — falls back to a random per-process secret otherwise
// (fine for local dev; existing sessions just don't survive a restart).
const PORTAL_JWT_SECRET = process.env.PORTAL_JWT_SECRET || randomUUID() + randomUUID();
if (!process.env.PORTAL_JWT_SECRET && isProduction) {
  logger.error('PORTAL_JWT_SECRET is not set in production — portal sessions will not survive a restart', {
    operation: 'startup',
    errorCode: 'MISSING_PORTAL_SECRET',
    status: 'failed',
  });
}

function requirePortalAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const payload = verifyPortalToken(token, PORTAL_JWT_SECRET);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  (req as Request & { portalUser?: PortalTokenPayload }).portalUser = payload;
  return next();
}

// Records live traffic outcomes against the provider management stats.
function recordTrafficResult(providerId: string | undefined, status: 'success' | 'failed' | 'pending' | 'unknown', latency: number) {
  if (!providerId) return;
  registry.recordTraffic(providerId, status === 'success', latency);
}

// Express 4 does not catch a rejected promise thrown by an async route
// handler — it becomes an unhandled promise rejection at the Node process
// level instead of reaching the `app.use((err, ...))` error middleware
// below, which crashes the entire gateway (every tenant, every route) on
// a single failed query. Wrap any async handler that doesn't already have
// its own try/catch with this so the error middleware gets a chance to
// turn it into a normal 500 response instead.
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// apps/web's /verify-email and /reset-password pages land this link and
// call the two routes below directly — PLATFORM_APP_URL points at
// wherever that deployment lives. Left unset, the link falls back to a
// relative path so the email is still well-formed; the raw token is
// always included as plain text too, so the email stays actionable (e.g.
// via a support-assisted API call) even if PLATFORM_APP_URL is
// misconfigured or that deployment is down.
function buildAccountLink(path: string, token: string): string {
  const base = (process.env.PLATFORM_APP_URL || '').replace(/\/+$/, '');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

// Fire-and-forget email sends for account flows — a failed/unconfigured
// send must never block signup, verification-resend, or a password-reset
// request. Errors are logged, not thrown.
function sendAccountEmail(kind: 'verify' | 'reset', to: string, token: string) {
  const url = kind === 'verify' ? buildAccountLink('/verify-email', token) : buildAccountLink('/reset-password', token);
  const html =
    (kind === 'verify' ? verificationEmailHtml(url) : passwordResetEmailHtml(url)) +
    `<p style="color:#64748b;font-size:13px">Token: <code>${token}</code></p>`;

  sendTransactionalEmail({
    to,
    subject: kind === 'verify' ? 'Verify your email' : 'Reset your password',
    html,
  }).then((result) => {
    if (!result.sent) {
      logger.warn('transactional email not sent', {
        operation: kind === 'verify' ? 'auth-verification-email' : 'auth-password-reset-email',
        errorCode: 'EMAIL_NOT_SENT',
        status: 'failed',
        error: result.error,
      });
    }
  });
}

// ----------------------------------------------------
// CUSTOMER ACCOUNT AUTH (full lifecycle: verification, password reset)
// ----------------------------------------------------
// A second, additional customer-auth surface alongside /v1/portal/* below
// (which provisions a tenant on signup for the portal UI's own session
// model). This one is the fuller developer/business account lifecycle —
// email verification, password reset, session revocation — that the
// portal routes don't cover. Distinct route namespace (/v1/api/auth/*),
// distinct JWT/session mechanism (opaque, revocable session tokens via
// AuthRegistry, not a portal JWT), so the two coexist without collision.
const authRegistry = new AuthRegistry(
  userRepository,
  userSessionRepository,
  userVerificationTokenRepository,
  roleRepository,
  new ApplicationRegistry(applicationRepository, apiKeyRepository),
);

type SessionAuthedRequest = Request & { user?: PublicUser };

async function requireSession(req: Request, res: Response, next: NextFunction) {
  const header = req.headers['authorization'];
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    return res.status(401).json({ error: 'Session token required' });
  }
  const user = await authRegistry.verifySession(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  (req as SessionAuthedRequest).user = user;
  return next();
}

// ----------------------------------------------------
// SUBSCRIPTIONS / BILLING
// ----------------------------------------------------
// Billing for the platform's own customers (the businesses that hold an
// application) — distinct from packages/providers/payments, which routes
// one-off payments those businesses make on their own behalf. Plan
// management is session-authed (requireSession, above); the webhook
// route is signature-verified instead, since Stripe calls it directly.
const subscriptionRegistry = new SubscriptionRegistry(planRepository, subscriptionRepository, applicationRepository);

// Real Stripe webhook signature verification (Stripe-Signature header:
// t=<unix seconds>,v1=<hex hmac-sha256(`${t}.${rawBody}`, secret)>) — NOT
// the generic WEBHOOK_HMAC_SECRET scheme used by /v1/api/webhooks/:provider,
// which only ever compares against this platform's own signing
// convention and would reject every genuine Stripe delivery.
function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, v];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // 5-minute tolerance, matching Stripe's own library default.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ----------------------------------------------------
// DEVELOPER CRM / SUPPORT BACK OFFICE
// ----------------------------------------------------
// BIS staff-facing (requireAdmin-gated, same single shared-secret admin
// auth used by every other /api/dashboard/* route) — a "customer" here is
// an `application`.
const crmRegistry = new CrmRegistry(
  applicationRepository,
  subscriptionRepository,
  planRepository,
  userRepository,
  customerNoteRepository,
  supportTicketRepository,
  ticketCommentRepository,
);

// ----------------------------------------------------
// OPERATIONAL ENDPOINTS
// ----------------------------------------------------

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'api-gateway',
    timestamp: new Date().toISOString()
  });
});

app.get('/ready', async (req: Request, res: Response) => {
  const deps: Record<string, string> = {};

  // P2-5: Check database connectivity
  try {
    const dbHealth = await checkDatabaseHealth();
    deps.database = dbHealth.status;
  } catch {
    deps.database = 'unreachable';
  }

  // P2-4: Report rate limiter backend
  const rlInfo = auth.getRateLimiterInfo();
  deps.rateLimiter = rlInfo.storeBacked ? 'redis' : 'in-memory';

  // Provider registry is in-memory — always "ready" if process is up
  deps.providers = 'ready';

  const allHealthy = Object.values(deps).every(
    (v) => v === 'healthy' || v === 'ready' || v === 'in-memory' || v === 'redis',
  );
  const status = allHealthy ? 'ready' : 'degraded';

  res.status(allHealthy ? 200 : 503).json({
    status,
    service: 'api-gateway',
    dependencies: deps,
    timestamp: new Date().toISOString()
  });
});

// ----------------------------------------------------
// GATEWAY TRAFFIC ENDPOINTS — P2-1: Versioned under /v1
// ----------------------------------------------------

// Wrapped in asyncHandler: any error that escapes the handler (including from
// the idempotency store) reaches the error middleware as a 500 instead of
// becoming an unhandled rejection that kills the whole gateway process.
app.post('/v1/api/gateway/payment', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { amount, currency, paymentMethod, providerOverride, phoneNumber } = req.body;
  const scope = authContext(req);
  const { tenantId } = scope;
  // Canonical header per docs/openapi.yaml is `Idempotency-Key`; `idempotency_key`
  // in the body is the documented fallback. (The previous `x-idempotency-key`
  // header name never matched what docs/SDK/clients actually send, so this
  // safeguard was silently inert.)
  const rawIdempotencyKey: unknown = req.header('idempotency-key') || req.body.idempotency_key;

  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }
  if (
    rawIdempotencyKey !== undefined && rawIdempotencyKey !== null && rawIdempotencyKey !== '' &&
    (typeof rawIdempotencyKey !== 'string' || rawIdempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  ) {
    return invalidRequest(res, 'idempotency_key', `Idempotency-Key must be a string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  const idempotencyKey: string | undefined = typeof rawIdempotencyKey === 'string' && rawIdempotencyKey !== '' ? rawIdempotencyKey : undefined;
  // The amount is now written to the transactions row BEFORE routing, so a
  // non-numeric/non-positive amount must be a 400 here, not a database error.
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return invalidRequest(res, 'amount', 'amount must be a positive number');
  }

  // paymentToken / country / metadata used to be silently dropped here, so
  // every card adapter fell back to a fabricated "success" (gap register
  // C1/E1). They are now validated and forwarded.
  const extras = parsePaymentExtras(req.body);
  if (!extras.ok) return invalidRequest(res, extras.field, extras.message);
  const { paymentToken, country, metadata } = extras.value;

  // Fingerprint the mutating fields so a replayed key with a *different*
  // payload is rejected instead of silently returning the wrong cached charge.
  // The hash is stored in idempotency_records.request_hash at claim time
  // (migration 0013), so a mismatch is caught even while the first request
  // is still in flight. It now also covers paymentToken/country/metadata
  // (undefined members are dropped, so requests without them hash exactly as
  // before). The raw fingerprint is still kept inside `result` for rows
  // claimed before request_hash existed, over the original five fields.
  const requestFingerprint = JSON.stringify({ amount, currency, paymentMethod, providerOverride, phoneNumber });
  const requestHash = computeRequestHash({ amount, currency, paymentMethod, providerOverride, phoneNumber, paymentToken, country, metadata });
  let idempotencyRecordId: string | undefined;

  if (idempotencyKey) {
    const claim = await claimIdempotencyKeyOrRespond(res, appId, tenantId, 'payment', idempotencyKey, requestHash);
    if (!claim) return;
    if (
      claim.outcome === 'conflict' ||
      (claim.outcome === 'replay' && claim.existingResult?.requestFingerprint !== requestFingerprint)
    ) {
      metrics.increment('paymentIdempotencyConflicts');
      return res.status(409).json({
        error: {
          code: 'idempotency_conflict',
          message: 'Idempotency-Key already used with a different payload',
          resource: claim.existingResult?.event,
        },
      });
    }
    if (claim.outcome === 'replay') {
      metrics.increment('paymentIdempotentHits');
      return res.status(claim.existingResult.event?.status === 'unknown' ? 202 : 200).json(claim.existingResult.event);
    }
    if (claim.outcome === 'in_progress') {
      res.setHeader('Retry-After', '1');
      return res.status(409).json({
        error: { code: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is already being processed' },
      });
    }
    idempotencyRecordId = claim.recordId!;
  }

  // Allocate the platform's transaction row (status 'processing') BEFORE
  // any provider call, so a stable payment_transaction_id exists for the
  // adapters' deterministic idempotency identity and the attempt is durably
  // recorded even if this process dies mid-call. Also enforces the Phase-2
  // guard: a key that already produced a (non-reopenable) transaction is
  // never charged again. See allocatePaymentTransaction().
  let allocation: PaymentAllocation;
  try {
    allocation = await allocatePaymentTransaction({
      appId,
      tenantId,
      amount: String(Number(amount)),
      currency: currency || 'USD',
      paymentMethod: paymentMethod || null,
      idempotencyKey: idempotencyKey ?? null,
      providerId: typeof providerOverride === 'string' ? providerOverride : null,
      // The verified supplier (if any) is recorded on the platform's own row
      // only — not forwarded to the provider.
      metadata: scope.supplierId ? { ...(metadata ?? {}), bisSupplierId: scope.supplierId } : metadata ?? null,
    });
  } catch (err) {
    if (idempotencyRecordId) {
      await platformIdempotency.fail(idempotencyRecordId, 'payment record allocation failed').catch(logIdempotencyFinaliseError(idempotencyRecordId, 'fail'));
    }
    logger.error('payment transaction allocation failed', {
      operation: 'payment-allocate-transaction',
      applicationId: appId,
      errorCode: 'PAYMENT_RECORD_UNAVAILABLE',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(503).json({
      error: {
        code: 'payment_record_unavailable',
        message: 'Could not create the payment record, so the payment was NOT attempted. Retry (with the same Idempotency-Key, if one was sent).',
      },
    });
  }

  if (allocation.kind === 'conflict') {
    const prior = allocation.existing;
    if (idempotencyRecordId) {
      await platformIdempotency.fail(idempotencyRecordId, 'key already used by an earlier payment').catch(logIdempotencyFinaliseError(idempotencyRecordId, 'fail'));
    }
    metrics.increment('paymentIdempotencyConflicts');
    return res.status(409).json({
      error: {
        code: 'idempotency_conflict',
        message: ['processing', 'unknown', 'requires_reconciliation', 'pending', 'requires_action'].includes(prior.status)
          ? 'Idempotency-Key belongs to an earlier payment whose outcome is not yet known (it may have been charged); it will not be attempted again — it is being reconciled with the provider. Use a new key only for a genuinely new payment'
          : 'Idempotency-Key was already used for an earlier payment whose replay window has expired; use a new key for a new payment',
        resource: paymentConflictResource(prior),
      },
    });
  }

  const paymentTransactionId = allocation.transaction.id;

  try {
    const routed = await routingEngine.routePayment(appId, {
      amount: Number(amount),
      currency,
      paymentMethod,
      providerOverride,
      phoneNumber,
      paymentToken,
      country,
      metadata,
      idempotencyKey,
      paymentTransactionId,
    });
    // Phase 7: the event carries the verified tenant (and supplier) — it is
    // what scopes outbound webhook dispatch, status lookup and refunds.
    const event = scopeEvent(routed, scope);

    // P0: update the pre-allocated transaction row with the provider's
    // outcome (the webhook processor updates it further from provider events).
    await recordPaymentOutcome(paymentTransactionId, event, currency || 'USD');

    eventBus.emit(event);
    observe(event);

    if (idempotencyRecordId) {
      await platformIdempotency.complete(idempotencyRecordId, { requestFingerprint, event }).catch(logIdempotencyFinaliseError(idempotencyRecordId, 'complete'));
    }

    // 202 for 'unknown' — e.g. a provider timeout (see routePayment's
    // ProviderTimeoutError branch). The outcome is genuinely unresolved
    // until the provider's own webhook confirms it, not something a client
    // should treat as a definite 200 success.
    return res.status(event.status === 'unknown' ? 202 : 200).json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
      tenantId,
      ...(scope.supplierId ? { supplierId: scope.supplierId } : {}),
      category: 'payment' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      amount: Number(amount) || 0,
      currency: currency || 'USD',
      latency: 50,
      cost: 0,
      decisionReason: 'routing_failure',
      payload: {},
      response: null,
      error: 'Payment routing failed',
      paymentTransactionId,
    };
    await recordPaymentRoutingFailure(paymentTransactionId, errorEvent.providerId, err instanceof Error ? err.message : String(err), metadata);
    eventBus.emit(errorEvent);
    observeFailure('payment', errorEvent.providerId, 'ROUTING_FAILED');
    observe(errorEvent);
    if (idempotencyRecordId) {
      await platformIdempotency.fail(idempotencyRecordId, errorEvent.error).catch(logIdempotencyFinaliseError(idempotencyRecordId, 'fail'));
    }
    return res.status(503).json({ error: 'Payment routing failed', id: errorEvent.id, paymentTransactionId });
  }
}));

app.post('/v1/api/gateway/messaging', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { recipient, content, providerOverride } = req.body;
  // P0: Use the authenticated (link-verified) tenant, NOT the request body
  const { tenantId, supplierId } = authContext(req);

  if (!appId || !recipient || !content) {
    return res.status(400).json({ error: 'Missing required parameters: appId, recipient, and content are required' });
  }

  try {
    const event = scopeEvent(
      await routingEngine.routeMessage(appId, {
        recipient,
        content,
        providerOverride,
        tenantId, // Pass authenticated tenant to routing engine
        // Phase 8: verified supplier scope → part of the conversation's
        // owner key (two hotels of one tenant on one shared number are two
        // conversations, not one).
        ...(supplierId ? { supplierId } : {}),
      }),
      { tenantId, supplierId },
    );

    eventBus.emit(event);
    observe(event);
    return res.json(event);
  } catch (err: any) {
    // Consent block is not a transient/retryable failure — surface it
    // distinctly (403) rather than the generic 503 routing failure, so
    // callers don't retry a send that will never succeed.
    const isConsentBlock = err instanceof ConsentBlockedError;
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
      tenantId,
      ...(supplierId ? { supplierId } : {}),
      category: 'messaging' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 30,
      cost: 0,
      decisionReason: isConsentBlock ? 'consent_blocked' : 'routing_failure',
      payload: {},
      response: null,
      error: isConsentBlock ? 'Recipient has opted out' : 'Message routing failed'
    };
    eventBus.emit(errorEvent);
    observeFailure('messaging', errorEvent.providerId, isConsentBlock ? 'CONSENT_BLOCKED' : 'ROUTING_FAILED');
    observe(errorEvent);
    if (isConsentBlock) {
      return res.status(403).json({ error: 'Recipient has opted out of messaging on this channel', id: errorEvent.id });
    }
    return res.status(503).json({ error: 'Message routing failed', id: errorEvent.id });
  }
});

app.post('/v1/api/gateway/other', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { serviceType, payload, providerOverride } = req.body;
  const scope = authContext(req);

  if (!appId || !serviceType) {
    return res.status(400).json({ error: 'Missing parameters: appId and serviceType are required' });
  }

  try {
    const event = scopeEvent(
      await routingEngine.routeOther(appId, {
        serviceType,
        payload,
        providerOverride
      }),
      scope,
    );

    eventBus.emit(event);
    observe(event);
    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
      tenantId: scope.tenantId,
      ...(scope.supplierId ? { supplierId: scope.supplierId } : {}),
      category: 'other' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 20,
      cost: 0,
      decisionReason: 'routing_failure',
      payload: {},
      response: null,
      error: 'Service routing failed'
    };
    eventBus.emit(errorEvent);
    observeFailure('other', errorEvent.providerId, 'ROUTING_FAILED');
    observe(errorEvent);
    return res.status(503).json({ error: 'Service routing failed', id: errorEvent.id });
  }
});

// ----------------------------------------------------
// TRANSACTION STATUS ENDPOINTS
// ----------------------------------------------------
// Consuming applications can poll for transaction status after submission.

app.get('/v1/api/gateway/transaction/:id', mw.apiKey, resolveTenantContext, (req: Request, res: Response) => {
  const { id } = req.params;
  const { appId, tenantId } = authContext(req);
  const events = eventBus.getHistory();

  // P0: Enforce ownership — only an event of the authenticated application
  // AND the authenticated tenant. Phase 7 (gap register C4 / GW-1.5): this
  // used to check appId only, so tenant B of a shared application could read
  // tenant A's payment by id (an id tenant B received through the
  // then-unscoped outbound webhook fan-out). An event with no tenant never
  // matches. Not-yours and does-not-exist are the same 404, so the route
  // cannot be used to probe for another tenant's ids.
  const event = events.find((e: TransactionEvent) => e.id === id && e.appId === appId && e.tenantId === tenantId);

  if (!event) {
    return res.status(404).json({ error: `Transaction '${id}' not found` });
  }

  const statusResponse: TransactionStatusResponse = {
    id: event.id,
    status: event.status,
    providerId: event.providerId,
    category: event.category,
    amount: event.amount,
    currency: event.currency,
    messageType: event.messageType,
    cost: event.cost,
    latency: event.latency,
    timestamp: event.timestamp,
    providerTransactionId: event.response?.id || event.response?.messageId || event.response?.transactionid,
    error: event.error,
  };

  return res.json(statusResponse);
});

// POST /refunds — refund a previously captured payment. See docs/openapi.yaml.
app.post('/refunds', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const refundScope = authContext(req);
  const { tenantId } = refundScope;
  const { payment_id: paymentId, amount, currency, reason, metadata } = req.body;
  const idempotencyKey: string | undefined = req.header('idempotency-key') || req.body.idempotency_key;

  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }
  if (!paymentId) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Missing required field: payment_id' } });
  }

  const requestFingerprint = JSON.stringify({ paymentId, amount, currency, reason });
  const requestHash = computeRequestHash({ paymentId, amount, currency, reason });
  let idempotencyRecordId: string | undefined;

  if (idempotencyKey) {
    const claim = await claimIdempotencyKeyOrRespond(res, appId, tenantId, 'refund', idempotencyKey, requestHash);
    if (!claim) return;
    if (
      claim.outcome === 'conflict' ||
      (claim.outcome === 'replay' && claim.existingResult?.requestFingerprint !== requestFingerprint)
    ) {
      return res.status(409).json({
        error: {
          code: 'idempotency_conflict',
          message: 'Idempotency-Key already used with a different payload',
          resource: claim.existingResult?.refund,
        },
      });
    }
    if (claim.outcome === 'replay') {
      return res.status(201).json(claim.existingResult.refund);
    }
    if (claim.outcome === 'in_progress') {
      res.setHeader('Retry-After', '1');
      return res.status(409).json({
        error: { code: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is already being processed' },
      });
    }
    idempotencyRecordId = claim.recordId;
  }

  // Ownership: only the application AND tenant that made the original
  // payment may refund it. Phase 7 (gap register C4 / GW-1.5): this used to
  // check appId only — the second half of the cross-tenant chain in which
  // tenant B, having received tenant A's payment id through the unscoped
  // webhook fan-out, could actually refund tenant A's payment. Not-yours is
  // the same 404 as does-not-exist.
  const original = eventBus
    .getHistory()
    .find((e: TransactionEvent) => e.id === paymentId && e.appId === appId && e.tenantId === tenantId && e.category === 'payment');

  if (!original) {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'payment not found').catch(() => undefined);
    return res.status(404).json({ error: { code: 'not_found', message: `Payment '${paymentId}' not found` } });
  }
  // Defense in depth: when the payment has a durable platform row (every
  // payment made through this gateway since Phase 3 does), its OWN
  // app_id/tenant_id must match too — the event history is process memory,
  // the transactions row is the authoritative record. Fails CLOSED: if the
  // row cannot be read, no money moves.
  if (original.paymentTransactionId) {
    let row: Awaited<ReturnType<typeof transactionRepository.findById>>;
    try {
      row = await transactionRepository.findById(original.paymentTransactionId);
    } catch {
      if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'payment record unavailable').catch(() => undefined);
      return res.status(503).json({ error: { code: 'payment_record_unavailable', message: 'Could not verify the payment record, so the refund was NOT attempted. Retry later.' } });
    }
    if (!row || row.appId !== appId || row.tenantId !== tenantId) {
      if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'payment not found').catch(() => undefined);
      return res.status(404).json({ error: { code: 'not_found', message: `Payment '${paymentId}' not found` } });
    }
  }
  if (original.status !== 'success') {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'payment not refundable').catch(() => undefined);
    return res.status(422).json({
      error: { code: 'invalid_operation', message: `Payment '${paymentId}' does not have a successful capture to refund` },
    });
  }
  if (amount != null && original.amount != null && Number(amount) > Number(original.amount)) {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'refund exceeds captured amount').catch(() => undefined);
    return res.status(422).json({
      error: { code: 'invalid_operation', message: 'Refund amount exceeds remaining captured amount' },
    });
  }

  const provider = registry.getProvider(original.providerId);
  if (!provider) {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'provider unavailable').catch(() => undefined);
    return res.status(503).json({ error: { code: 'provider_unavailable', message: `Provider '${original.providerId}' is unavailable` } });
  }

  try {
    const refundEvent = scopeEvent(
      await provider.refund(
        appId,
        { originalTransactionId: paymentId, amount, currency: currency || original.currency, reason, metadata },
        'refund_requested',
      ),
      refundScope,
    );

    eventBus.emit(refundEvent);
    observe(refundEvent);

    const refund = {
      id: refundEvent.id,
      object: 'refund' as const,
      payment_id: paymentId,
      status: refundEvent.status === 'success' ? 'success' : refundEvent.status === 'failed' ? 'failed' : 'pending',
      amount: amount ?? original.amount,
      currency: currency || original.currency,
      reason,
      provider_refund_id: refundEvent.response?.id,
      created_at: refundEvent.timestamp,
    };

    if (idempotencyRecordId) {
      await platformIdempotency.complete(idempotencyRecordId, { requestFingerprint, refund }).catch(logIdempotencyFinaliseError(idempotencyRecordId, 'complete'));
    }

    return res.status(201).json(refund);
  } catch (err: any) {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, err.message).catch(logIdempotencyFinaliseError(idempotencyRecordId, 'fail'));
    observeFailure('payment', original.providerId, 'REFUND_FAILED');
    return res.status(503).json({ error: { code: 'refund_failed', message: 'Refund failed' } });
  }
}));

// ----------------------------------------------------
// CUSTOMER ACCOUNT AUTH ROUTES (/v1/api/auth/*)
// ----------------------------------------------------
app.post('/v1/api/auth/signup', async (req: Request, res: Response) => {
  const { email, password, name, applicationName, applicationSlug } = req.body || {};
  try {
    const result = await authRegistry.signup({ email, password, name, applicationName, applicationSlug });
    logger.info('account signup', {
      operation: 'auth-signup',
      applicationId: result.application.id,
      status: 'success',
    });
    sendAccountEmail('verify', result.user.email, result.emailVerificationToken);
    return res.status(201).json({
      user: result.user,
      application: result.application,
      apiKey: result.apiKey,
      // The token is also surfaced directly outside production, in
      // addition to the real send above — keeps signup/verification
      // testable end to end without depending on a real inbox, and gives
      // a fallback if RESEND_API_KEY isn't configured in a dev/staging
      // environment.
      ...(process.env.NODE_ENV !== 'production'
        ? { emailVerificationToken: result.emailVerificationToken }
        : {}),
    });
  } catch (err: any) {
    const status = err instanceof ValidationError ? 400 : err instanceof ConflictError ? 409 : 500;
    if (status === 500) {
      logger.error('signup failed', { operation: 'auth-signup', errorCode: 'SIGNUP_FAILED', status: 'failed' });
    }
    return res.status(status).json({ error: err.message || 'Signup failed' });
  }
});

app.post('/v1/api/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const result = await authRegistry.login({
      email,
      password,
      userAgent: req.header('user-agent'),
      ipAddress: req.ip,
    });
    return res.json({ user: result.user, token: result.token, expiresAt: result.expiresAt });
  } catch (err: any) {
    const status = err instanceof AuthError ? 401 : 500;
    return res.status(status).json({ error: err.message || 'Login failed' });
  }
});

app.post('/v1/api/auth/logout', requireSession, asyncHandler(async (req: Request, res: Response) => {
  const header = req.headers['authorization'] as string;
  await authRegistry.logout(header.slice(7));
  return res.status(204).send();
}));

app.get('/v1/api/auth/me', requireSession, (req: Request, res: Response) => {
  return res.json({ user: (req as SessionAuthedRequest).user });
});

app.post('/v1/api/auth/verify-email', async (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    const user = await authRegistry.verifyEmail(token);
    return res.json({ user });
  } catch (err: any) {
    return res.status(err instanceof AuthError ? 400 : 500).json({ error: err.message || 'Verification failed' });
  }
});

app.post('/v1/api/auth/resend-verification', requireSession, asyncHandler(async (req: Request, res: Response) => {
  const user = (req as SessionAuthedRequest).user!;
  const { token } = await authRegistry.resendEmailVerification(user.id);
  sendAccountEmail('verify', user.email, token);
  return res.json({
    message: 'Verification email requested',
    ...(process.env.NODE_ENV !== 'production' ? { emailVerificationToken: token } : {}),
  });
}));

app.post('/v1/api/auth/request-password-reset', asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  const result = await authRegistry.requestPasswordReset(email);
  if (result) sendAccountEmail('reset', email, result.token);
  // Always a generic success — never reveal whether the account exists.
  return res.json({
    message: 'If an account exists for this email, a password reset link has been sent.',
    ...(process.env.NODE_ENV !== 'production' && result ? { passwordResetToken: result.token } : {}),
  });
}));

app.post('/v1/api/auth/reset-password', async (req: Request, res: Response) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  try {
    await authRegistry.resetPassword(token, password);
    return res.json({ message: 'Password reset successful' });
  } catch (err: any) {
    const status = err instanceof ValidationError || err instanceof AuthError ? 400 : 500;
    return res.status(status).json({ error: err.message || 'Password reset failed' });
  }
});

// ----------------------------------------------------
// BILLING ROUTES (/v1/api/billing/*)
// ----------------------------------------------------
app.get('/v1/api/billing/plans', asyncHandler(async (_req: Request, res: Response) => {
  const plans = await subscriptionRegistry.listPlans();
  return res.json({ plans });
}));

app.get('/v1/api/billing/subscription', requireSession, asyncHandler(async (req: Request, res: Response) => {
  const user = (req as SessionAuthedRequest).user!;
  const subscription = await subscriptionRegistry.getSubscription(user.applicationId);
  return res.json({ subscription: subscription ?? null });
}));

app.post('/v1/api/billing/subscribe', requireSession, async (req: Request, res: Response) => {
  const user = (req as SessionAuthedRequest).user!;
  const { planSlug } = req.body || {};
  if (!planSlug) return res.status(400).json({ error: 'planSlug is required' });
  try {
    const subscription = await subscriptionRegistry.subscribe(user.applicationId, planSlug, user.email);
    return res.json({ subscription });
  } catch (err: any) {
    const status = err instanceof SubscriptionError ? 400 : 500;
    if (status === 500) {
      logger.error('subscribe failed', {
        operation: 'billing-subscribe',
        applicationId: user.applicationId,
        errorCode: 'SUBSCRIBE_FAILED',
        status: 'failed',
      });
    }
    return res.status(status).json({ error: err.message || 'Subscription failed' });
  }
});

app.post('/v1/api/billing/cancel', requireSession, async (req: Request, res: Response) => {
  const user = (req as SessionAuthedRequest).user!;
  const atPeriodEnd = req.body?.atPeriodEnd !== false; // defaults to true — cancel at period end, not immediately
  try {
    const subscription = await subscriptionRegistry.cancelSubscription(user.applicationId, atPeriodEnd);
    return res.json({ subscription });
  } catch (err: any) {
    const status = err instanceof SubscriptionError ? 400 : 500;
    return res.status(status).json({ error: err.message || 'Cancellation failed' });
  }
});

app.post('/v1/api/billing/webhooks/stripe', async (req: Request, res: Response) => {
  const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!secret) {
    logger.error('billing webhook rejected — no secret configured', {
      operation: 'billing-webhook',
      errorCode: 'NO_WEBHOOK_SECRET',
      status: 'failed',
    });
    return res.status(503).json({ error: 'Webhook verification not configured' });
  }
  if (!rawBody || !verifyStripeSignature(rawBody, req.header('stripe-signature'), secret)) {
    logger.error('billing webhook rejected — invalid signature', {
      operation: 'billing-webhook',
      errorCode: 'INVALID_SIGNATURE',
      status: 'failed',
    });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Phase 4: this webhook gets the same DB-enforced durable identity as
  // /v1/api/webhooks/:provider — ('stripe-billing', event.id), unique in
  // webhook_events — and its processing state lives in
  // webhook_event_consumers ('billing_sync'). It is still processed inline
  // (acknowledged only after the subscription sync succeeded; a failure
  // answers 500 so Stripe retries, and the retry re-claims cleanly). A
  // redelivery of an already-processed event is acknowledged as a duplicate
  // without re-running the sync. 'stripe-billing' (not 'stripe') because
  // Stripe sends the same event id to every endpoint registered on an
  // account, and this endpoint's processing is independent of the payments
  // webhook route's.
  const event = req.body;
  const eventId = extractProviderEventId(event);
  if (!eventId) {
    return res.status(400).json({ error: 'Webhook payload must include an event "id"' });
  }
  try {
    let updated: Awaited<ReturnType<typeof subscriptionRegistry.syncFromStripeEvent>> = null;
    const result = await runDurableWebhookConsumer(
      webhookEventRepository,
      'billing_sync',
      {
        providerId: 'stripe-billing',
        providerEventId: eventId,
        fallbackRow: () => ({
          appId: null,
          tenantId: null,
          eventType: boundedString(event?.type),
          payload: event,
          rawBody: rawBody.toString('utf8'),
          signature: req.header('stripe-signature') ?? null,
        }),
      },
      async () => {
        updated = await subscriptionRegistry.syncFromStripeEvent(event);
      },
    );
    if (result.outcome === 'replay') {
      return res.json({ received: true, duplicate: true });
    }
    logger.info('billing webhook processed', {
      operation: 'billing-webhook',
      status: 'success',
      applicationId: (updated as { applicationId?: string } | null)?.applicationId,
    });
    return res.json({ received: true });
  } catch (err: any) {
    if (err instanceof WebhookConsumerBusyError) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'Webhook is being processed by a concurrent delivery; retry later' });
    }
    logger.error('billing webhook processing failed', {
      operation: 'billing-webhook',
      errorCode: 'PROCESSING_FAILED',
      status: 'failed',
    });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ----------------------------------------------------
// CONSENT (/v1/api/consent/*)
// ----------------------------------------------------
app.get('/v1/api/consent/:recipient', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { tenantId } = authContext(req);
  const recipient = req.params.recipient;
  const channel = typeof req.query.channel === 'string' ? req.query.channel : 'sms';

  if (!appId) {
    return res.status(400).json({ error: 'Missing authenticated appId' });
  }

  const record = await consentRecordRepository.findByRecipient(appId, tenantId, recipient, channel);
  return res.json({
    recipient,
    channel,
    status: record?.status ?? 'unknown',
    source: record?.source ?? null,
    updatedAt: record?.updatedAt ?? null,
  });
}));

app.post('/v1/api/consent', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { tenantId } = authContext(req);
  const { recipient, channel, status } = req.body;

  if (!appId || !recipient || !channel || !status) {
    return res.status(400).json({ error: 'Missing required parameters: recipient, channel, and status are required' });
  }
  if (!['opted_in', 'opted_out', 'unknown'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: opted_in, opted_out, unknown' });
  }

  const record = await consentRecordRepository.upsert({
    appId,
    tenantId,
    recipient,
    channel,
    status,
    source: 'api',
  });
  return res.json({
    recipient: record.recipient,
    channel: record.channel,
    status: record.status,
    source: record.source,
    updatedAt: record.updatedAt,
  });
}));

// ----------------------------------------------------
// MESSAGING PROFILES — A2P/10DLC compliance model
// (/v1/api/gateway/messaging-profiles). An application registers the
// senders it uses per country/provider; complianceStatus tracks
// real-world registration state (e.g. US 10DLC campaign approval). Scope
// here is the registration record and its CRUD surface — NOT enforcement
// (outbound sends are not blocked on complianceStatus) and NOT
// integration with a real carrier/registrar API.
// ----------------------------------------------------
app.get('/v1/api/gateway/messaging-profiles', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) {
    return res.status(400).json({ error: 'Missing authenticated appId' });
  }
  // Phase 7 (gap register F3.2): the authenticated tenant's profiles only —
  // this used to return every tenant's sender registrations under the app.
  const { tenantId } = authContext(req);
  const profiles = await messagingProfileRepository.findByAppAndTenant(appId, tenantId);
  return res.json({ profiles, count: profiles.length });
}));

app.post('/v1/api/gateway/messaging-profiles', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  // Phase 8: a sender can be dedicated to one supplier (e.g. one STAYSCAPE
  // hotel's own number) — taken ONLY from the verified x-supplier-id scope.
  const { tenantId, supplierId } = authContext(req);
  const { country, senderType, sender, provider, campaignId, brandId } = req.body;

  if (!appId || !country || !senderType || !sender || !provider) {
    return res.status(400).json({ error: 'Missing required parameters: country, senderType, sender, and provider are required' });
  }

  try {
    const profile = await messagingProfileRepository.create({
      appId,
      tenantId,
      country,
      senderType,
      sender,
      provider,
      campaignId,
      brandId,
      supplierId: supplierId ?? null,
    });
    return res.json(profile);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to create messaging profile' });
  }
});

app.patch('/api/dashboard/messaging-profiles/:id', requireAdmin, async (req: Request, res: Response) => {
  const { complianceStatus } = req.body || {};
  if (!complianceStatus) {
    return res.status(400).json({ error: 'complianceStatus is required' });
  }
  try {
    const profile = await messagingProfileRepository.updateComplianceStatus(req.params.id, complianceStatus);
    return res.json(profile);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to update compliance status' });
  }
});

// ----------------------------------------------------
// KEYWORD COMMANDS (Phase 9, gap register A13)
// ----------------------------------------------------
// Each application/tenant defines its OWN inbound keyword commands instead
// of every tenant getting the platform's hard-coded church wording:
//   - tenant scope (/v1/api/gateway/keyword-commands, API key + verified
//     x-tenant-id): the authenticated tenant's own commands/overrides;
//   - application scope (/api/dashboard/applications/:appId/keyword-commands,
//     requireAdmin): defaults for every tenant of an application.
// STOP/START/HELP/YES/NO are always recognised by the platform with fixed
// consent semantics; a row with one of those names can only change its
// reply WORDING (validated in @company/database's keyword grammar).
// App-specific 'dispatch' commands are delivered to the owning application
// as a tenant-scoped 'keyword_command' event (webhook) and as durable rows
// it can pull and acknowledge (/v1/api/gateway/keyword-dispatches).
function keywordCommandView(row: KeywordCommand) {
  return {
    id: row.id,
    scope: row.tenantId === null ? 'application' : 'tenant',
    keyword: row.keyword,
    aliases: row.aliases,
    action: row.action,
    responseText: row.responseText,
    helpText: row.helpText,
    workflowId: row.workflowId,
    enabled: row.enabled,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

function keywordDispatchView(row: KeywordCommandDispatch) {
  return {
    id: row.id,
    keyword: row.keyword,
    argument: row.argument,
    workflowId: row.workflowId,
    conversationId: row.conversationId,
    customerPhone: row.customerPhone,
    businessNumber: row.businessNumber,
    channel: row.channel,
    content: row.content,
    supplierId: row.supplierId,
    status: row.status,
    createdAt: row.createdAt,
    acknowledgedAt: row.acknowledgedAt,
  };
}

function keywordCommandError(res: Response, err: unknown) {
  if (err instanceof KeywordCommandValidationError) return invalidRequest(res, err.field, err.message);
  throw err;
}

const UNIVERSAL_KEYWORDS_VIEW = {
  reserved: RESERVED_KEYWORD_NAMES,
  note: 'STOP/START/HELP/YES/NO are recognised for every owner with fixed consent semantics; only their reply wording is configurable.',
};

app.get('/v1/api/gateway/keyword-commands', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) return res.status(400).json({ error: 'Missing authenticated appId' });
  const { tenantId } = authContext(req);
  const [applicationDefaults, tenantOverrides, effective] = await Promise.all([
    keywordCommandRepository.listForScope(appId, null),
    keywordCommandRepository.listForScope(appId, tenantId),
    keywordCommandRepository.findEffectiveForOwner(appId, tenantId),
  ]);
  return res.json({
    universal: UNIVERSAL_KEYWORDS_VIEW,
    applicationDefaults: applicationDefaults.map(keywordCommandView),
    tenantOverrides: tenantOverrides.map(keywordCommandView),
    effective: effective.map(keywordCommandView),
  });
}));

app.put('/v1/api/gateway/keyword-commands/:keyword', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) return res.status(400).json({ error: 'Missing authenticated appId' });
  // The tenant comes ONLY from the verified context — never the body.
  const { tenantId } = authContext(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const row = await keywordCommandRepository.upsert(
      appId,
      tenantId,
      {
        keyword: req.params.keyword,
        action: body.action as string,
        aliases: body.aliases,
        responseText: body.responseText,
        helpText: body.helpText,
        workflowId: body.workflowId,
        enabled: body.enabled,
      },
      `tenant:${tenantId}`,
    );
    logger.info('keyword command configured', { operation: 'keyword-command-upsert', status: 'success', applicationId: appId, tenantId });
    return res.json(keywordCommandView(row));
  } catch (err) {
    return keywordCommandError(res, err);
  }
}));

app.delete('/v1/api/gateway/keyword-commands/:keyword', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) return res.status(400).json({ error: 'Missing authenticated appId' });
  const { tenantId } = authContext(req);
  const removed = await keywordCommandRepository.remove(appId, tenantId, req.params.keyword);
  return removed ? res.json({ deleted: true }) : res.status(404).json({ error: 'keyword command not found for this tenant' });
}));

app.get('/v1/api/gateway/keyword-dispatches', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) return res.status(400).json({ error: 'Missing authenticated appId' });
  const { tenantId, supplierId } = authContext(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !['pending', 'acknowledged'].includes(status)) {
    return invalidRequest(res, 'status', "status must be 'pending' or 'acknowledged'");
  }
  const limit = Number(req.query.limit);
  const rows = await keywordCommandDispatchRepository.listForOwner(appId, tenantId, {
    status,
    supplierId: supplierId ?? null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  return res.json({ data: rows.map(keywordDispatchView), count: rows.length });
}));

app.post('/v1/api/gateway/keyword-dispatches/:id/ack', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) return res.status(400).json({ error: 'Missing authenticated appId' });
  if (!UUID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'invalid dispatch id' });
  const { tenantId, supplierId } = authContext(req);
  const row = await keywordCommandDispatchRepository.acknowledge(req.params.id, { appId, tenantId, supplierId: supplierId ?? null });
  // 404 for "not yours" and "not pending" alike — never confirm another
  // tenant's dispatch exists.
  return row ? res.json(keywordDispatchView(row)) : res.status(404).json({ error: 'pending dispatch not found' });
}));

app.get('/api/dashboard/applications/:appId/keyword-commands', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const rows = await keywordCommandRepository.listForScope(req.params.appId, null);
  return res.json({ universal: UNIVERSAL_KEYWORDS_VIEW, applicationDefaults: rows.map(keywordCommandView) });
}));

app.put('/api/dashboard/applications/:appId/keyword-commands/:keyword', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // The admin token carries no identity (gap register C7): the operator
  // names themselves, recorded verbatim on the row.
  if (typeof body.updatedBy !== 'string' || body.updatedBy.trim() === '' || body.updatedBy.length > 200) {
    return invalidRequest(res, 'updatedBy', 'updatedBy is required, at most 200 characters');
  }
  try {
    const row = await keywordCommandRepository.upsert(
      req.params.appId,
      null,
      {
        keyword: req.params.keyword,
        action: body.action as string,
        aliases: body.aliases,
        responseText: body.responseText,
        helpText: body.helpText,
        workflowId: body.workflowId,
        enabled: body.enabled,
      },
      `operator:${body.updatedBy.trim()}`,
    );
    logger.warn('application-wide keyword command configured', {
      operation: 'keyword-command-upsert',
      status: 'success',
      applicationId: req.params.appId,
    });
    return res.json(keywordCommandView(row));
  } catch (err) {
    return keywordCommandError(res, err);
  }
}));

app.delete('/api/dashboard/applications/:appId/keyword-commands/:keyword', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const removed = await keywordCommandRepository.remove(req.params.appId, null, req.params.keyword);
  return removed ? res.json({ deleted: true }) : res.status(404).json({ error: 'keyword command not found' });
}));

// ----------------------------------------------------
// OUTBOUND WEBHOOK REGISTRATION (/v1/api/gateway/webhooks)
// ----------------------------------------------------
// Register a callback URL to receive a signed TransactionEvent (see
// dispatchOutboundWebhooks, above) as this application's payments/
// messages/other events happen. The signing secret is returned exactly
// once, here — it's never re-displayed, only used server-side to compute
// each delivery's X-Webhook-Signature header.
app.post('/v1/api/gateway/webhooks', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { tenantId } = authContext(req);
  const { url, events } = req.body || {};

  if (!appId) {
    return res.status(400).json({ error: 'Missing authenticated appId' });
  }
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'url must be a valid URL' });
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && process.env.NODE_ENV !== 'production')) {
    return res.status(400).json({ error: 'url must use https (http is only allowed outside production)' });
  }
  if (events !== undefined && (!Array.isArray(events) || events.some((e: unknown) => typeof e !== 'string'))) {
    return res.status(400).json({ error: 'events must be an array of strings when provided' });
  }

  try {
    const { endpoint, secret } = await webhookEndpointRepository.create({
      appId,
      tenantId,
      url,
      eventTypes: events,
    });
    return res.status(201).json({
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.eventTypes,
      active: endpoint.active,
      createdAt: endpoint.createdAt,
      // Shown once — store it now. Every subsequent GET omits it.
      secret,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to register webhook endpoint' });
  }
}));

app.get('/v1/api/gateway/webhooks', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) {
    return res.status(400).json({ error: 'Missing authenticated appId' });
  }
  // Phase 7 (gap register C4 / F3.2): the authenticated tenant's endpoints
  // only — this used to list every tenant's registrations under the app.
  const { tenantId } = authContext(req);
  const endpoints = await webhookEndpointRepository.findByAppAndTenant(appId, tenantId);
  return res.json({
    endpoints: endpoints.map((e) => ({
      id: e.id,
      url: e.url,
      events: e.eventTypes,
      active: e.active,
      createdAt: e.createdAt,
    })),
    count: endpoints.length,
  });
}));

app.delete('/v1/api/gateway/webhooks/:id', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) {
    return res.status(400).json({ error: 'Missing authenticated appId' });
  }
  // Phase 7: scoped to (app, tenant) — another tenant's endpoint is a 404,
  // exactly like one that does not exist (this used to check appId only, so
  // tenant B could delete tenant A's endpoint).
  const { tenantId } = authContext(req);
  const deleted = await webhookEndpointRepository.deleteScoped(req.params.id, appId, tenantId);
  if (!deleted) {
    return res.status(404).json({ error: 'Webhook endpoint not found' });
  }
  return res.status(204).send();
}));

// ----------------------------------------------------
// SUPPLIERS (/v1/api/gateway/suppliers) — Phase 7, gap register F3.8
// ----------------------------------------------------
// The Application → Tenant → Supplier boundary for multi-supplier
// applications (Afribook vendors, STAYSCAPE hosts). A supplier always
// belongs to the AUTHENTICATED application (its UUID, resolved from the API
// key's slug) and the AUTHENTICATED tenant; any applicationId / tenantId /
// supplierId in the body was already stripped by resolveTenantContext. Every
// read goes through SupplierScope, which verifies the whole chain; another
// tenant's (or application's) supplier is a 404, never a 403 that would
// confirm it exists. Any /v1/api/gateway/* request may also act FOR one of
// its own suppliers by sending x-supplier-id (verified the same way, 403 if
// not owned); the verified supplier is stamped on the resulting event and
// recorded on the payment's transactions row.

const SUPPLIER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function supplierView(s: { id: string; slug: string; name: string; type: string; status: string; tenantId: string; createdAt?: Date | string | null }) {
  return { id: s.id, slug: s.slug, name: s.name, type: s.type, status: s.status, tenantId: s.tenantId, createdAt: s.createdAt ?? null };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

app.get('/v1/api/gateway/suppliers', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId } = authContext(req);
  const suppliers = await supplierScope.listOwnedSuppliers({ appSlug: appId, tenantId });
  return res.json({ suppliers: suppliers.map(supplierView), count: suppliers.length });
}));

app.get('/v1/api/gateway/suppliers/:id', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId } = authContext(req);
  const supplier = await supplierScope.resolveOwnedSupplier({ appSlug: appId, tenantId, supplierRef: req.params.id });
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  return res.json(supplierView(supplier));
}));

app.post('/v1/api/gateway/suppliers', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const { applicationUuid, tenantId } = authContext(req);
  const { name, slug, type, metadata } = req.body ?? {};
  if (typeof name !== 'string' || name.trim() === '' || name.length > 200) {
    return invalidRequest(res, 'name', 'name is required (at most 200 characters)');
  }
  if (typeof slug !== 'string' || !SUPPLIER_SLUG_RE.test(slug)) {
    return invalidRequest(res, 'slug', 'slug must be 1-63 characters of a-z, 0-9 and "-", starting with a letter or digit');
  }
  if (typeof type !== 'string' || type.trim() === '' || type.length > 64) {
    return invalidRequest(res, 'type', 'type is required (e.g. hotel, church, organization), at most 64 characters');
  }
  if (metadata !== undefined && metadata !== null && !isPlainObject(metadata)) {
    return invalidRequest(res, 'metadata', 'metadata must be a JSON object when provided');
  }
  if (await supplierRepository.findByApplicationAndSlug(applicationUuid, tenantId, slug)) {
    return res.status(409).json({ error: { code: 'conflict', message: `A supplier with slug '${slug}' already exists for this tenant` } });
  }
  try {
    const created = await supplierRepository.create({
      applicationId: applicationUuid,
      tenantId,
      name: name.trim(),
      slug,
      type: type.trim(),
      metadata: metadata ?? null,
    });
    return res.status(201).json(supplierView(created));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: { code: 'conflict', message: `A supplier with slug '${slug}' already exists for this tenant` } });
    }
    throw err;
  }
}));

// ----------------------------------------------------
// DEVELOPER CRM / SUPPORT BACK OFFICE (/api/dashboard/customers,
// /api/dashboard/tickets) — a "customer" here is an `application`.
// ----------------------------------------------------
app.get('/api/dashboard/customers', requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  const customers = await crmRegistry.listCustomers();
  return res.json({ customers });
}));

app.get('/api/dashboard/customers/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const customer = await crmRegistry.getCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  return res.json(customer);
}));

app.post('/api/dashboard/customers/:id/notes', requireAdmin, async (req: Request, res: Response) => {
  const { body, authorName } = req.body || {};
  try {
    const note = await crmRegistry.addNote(req.params.id, authorName, body);
    return res.status(201).json(note);
  } catch (err: any) {
    return res.status(err instanceof CrmError ? 400 : 500).json({ error: err.message || 'Failed to add note' });
  }
});

app.get('/api/dashboard/tickets', requireAdmin, async (req: Request, res: Response) => {
  try {
    const tickets = await crmRegistry.listTickets(req.query.status as string | undefined);
    return res.json({ tickets });
  } catch (err: any) {
    return res.status(err instanceof CrmError ? 400 : 500).json({ error: err.message || 'Failed to list tickets' });
  }
});

app.get('/api/dashboard/tickets/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const result = await crmRegistry.getTicket(req.params.id);
  if (!result) return res.status(404).json({ error: 'Ticket not found' });
  return res.json(result);
}));

app.post('/api/dashboard/customers/:id/tickets', requireAdmin, async (req: Request, res: Response) => {
  const { subject, description, priority, requesterEmail } = req.body || {};
  try {
    const ticket = await crmRegistry.createTicket(req.params.id, { subject, description, priority, requesterEmail });
    return res.status(201).json(ticket);
  } catch (err: any) {
    return res.status(err instanceof CrmError ? 400 : 500).json({ error: err.message || 'Failed to create ticket' });
  }
});

app.patch('/api/dashboard/tickets/:id', requireAdmin, async (req: Request, res: Response) => {
  const { status, priority } = req.body || {};
  try {
    const ticket = await crmRegistry.updateTicket(req.params.id, { status, priority });
    return res.json(ticket);
  } catch (err: any) {
    return res.status(err instanceof CrmError ? 400 : 500).json({ error: err.message || 'Failed to update ticket' });
  }
});

app.post('/api/dashboard/tickets/:id/comments', requireAdmin, async (req: Request, res: Response) => {
  const { body, authorName } = req.body || {};
  try {
    const comment = await crmRegistry.addTicketComment(req.params.id, authorName, body);
    return res.status(201).json(comment);
  } catch (err: any) {
    return res.status(err instanceof CrmError ? 400 : 500).json({ error: err.message || 'Failed to add comment' });
  }
});

// Backs the admin console's "Interactive Request Playground" — an
// admin-authenticated way to exercise real routing decisions without a
// per-application API key. Routes through the same routingEngine.route*()
// calls the real, API-key-authed /v1/api/gateway/* routes use (and emits
// the same events), so a dispatched request shows up in Observability/
// AuditLogs/LiveTopology exactly like real traffic would.
//
// Phase 7 (gap register C8 / GW-1.2). This route can move real money and
// send real messages, but it used to take `appId` from the body and pass NO
// tenant at all: messaging consent (STOP) was checked against tenant
// 'default' — so a recipient who opted out under their real tenant was NOT
// blocked — and payments were filed under a fake 'admin-playground' tenant
// no real tenant could ever reconcile. The admin token is platform-wide
// authority (it carries no tenant), so the admin must now name BOTH the
// application and the tenant explicitly, and the pair is verified exactly
// like a tenant-scoped API request (application exists and is active, the
// tenant has an ACTIVE link to it) before anything is sent:
//   - consent is checked under that real tenant (opt-outs are honoured);
//   - payments are recorded on that tenant's transactions, tagged
//     metadata.bisSource = 'admin_playground';
//   - every emitted event carries that tenantId (so webhook dispatch,
//     status and refunds stay tenant-scoped) and `adminInitiated: true`, and
//     its decisionReason is prefixed 'admin_playground:' — it can never be
//     mistaken for the tenant's own API traffic.
// (Unscoped "admin" sends were rejected as the alternative: they would
// bypass per-tenant consent by construction.)
app.post('/api/dashboard/playground/dispatch', requireAdmin, async (req: Request, res: Response) => {
  const { category, appId, tenantId, ...fields } = req.body || {};

  if (!appId || !category) {
    return res.status(400).json({ error: 'appId and category are required' });
  }
  if (typeof appId !== 'string' || typeof tenantId !== 'string' || tenantId.trim() === '') {
    return res.status(400).json({ error: 'tenantId is required: playground traffic is always sent as a specific, verified tenant of the application' });
  }
  let playgroundTenantOk: boolean;
  try {
    playgroundTenantOk = (await supplierScope.resolveTenantApplication({ appSlug: appId, tenantId })) !== null;
  } catch {
    playgroundTenantOk = false; // fail closed on a lookup error
  }
  if (!playgroundTenantOk) {
    return res.status(403).json({ error: 'tenantId is not an active tenant of this application' });
  }
  const markAdmin = <T extends TransactionEvent>(e: T): T & { adminInitiated: true } => ({
    ...scopeEvent(e, { tenantId }),
    decisionReason: `admin_playground:${e.decisionReason}`,
    adminInitiated: true as const,
  });

  try {
    let event: TransactionEvent;
    if (category === 'payment') {
      const { amount, currency, paymentMethod, providerOverride, phoneNumber } = fields;
      const extras = parsePaymentExtras(fields);
      if (!extras.ok) return invalidRequest(res, extras.field, extras.message);
      if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        return invalidRequest(res, 'amount', 'amount must be a positive number');
      }
      const idempotencyKey = typeof fields.idempotencyKey === 'string' && fields.idempotencyKey ? fields.idempotencyKey : undefined;
      // Same rule as the public route: a durable transaction row (and its id,
      // the provider idempotency identity's payment_transaction_id) exists
      // before any provider is called — the playground can reach real
      // providers too. Recorded under the verified tenant it was sent as
      // (Phase 7 — it used to be a fake 'admin-playground' tenant), tagged
      // as admin-initiated in its metadata.
      const allocation = await allocatePaymentTransaction({
        appId,
        tenantId,
        amount: String(Number(amount)),
        currency: currency || 'USD',
        paymentMethod: paymentMethod || null,
        idempotencyKey: idempotencyKey ?? null,
        providerId: typeof providerOverride === 'string' ? providerOverride : null,
        metadata: { ...(extras.value.metadata ?? {}), bisSource: 'admin_playground' },
      });
      if (allocation.kind === 'conflict') {
        return res.status(409).json({ error: { code: 'idempotency_conflict', resource: paymentConflictResource(allocation.existing) } });
      }
      const paymentTransactionId = allocation.transaction.id;
      try {
        event = markAdmin(await routingEngine.routePayment(appId, {
          amount: Number(amount),
          currency,
          paymentMethod,
          providerOverride,
          phoneNumber,
          paymentToken: extras.value.paymentToken,
          country: extras.value.country,
          metadata: extras.value.metadata,
          idempotencyKey,
          paymentTransactionId,
        }));
      } catch (routeErr) {
        await recordPaymentRoutingFailure(
          paymentTransactionId,
          providerOverride || 'failed_route',
          routeErr instanceof Error ? routeErr.message : String(routeErr),
          extras.value.metadata,
        );
        throw routeErr;
      }
      await recordPaymentOutcome(paymentTransactionId, event, currency || 'USD');
    } else if (category === 'messaging') {
      const { recipient, content, providerOverride } = fields;
      // Consent is checked under the REAL tenant (it used to be 'default').
      event = markAdmin(await routingEngine.routeMessage(appId, { recipient, content, providerOverride, tenantId }));
    } else if (category === 'other') {
      const { serviceType, payload, providerOverride } = fields;
      event = markAdmin(await routingEngine.routeOther(appId, { serviceType, payload, providerOverride }));
    } else {
      return res.status(400).json({ error: `Unknown category: ${category}` });
    }

    eventBus.emit(event);
    observe(event);
    return res.status(event.status === 'unknown' ? 202 : 200).json(event);
  } catch (err: any) {
    const isConsentBlock = err instanceof ConsentBlockedError;
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
      tenantId,
      adminInitiated: true as const,
      category,
      providerId: fields.providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 30,
      cost: 0,
      decisionReason: `admin_playground:${isConsentBlock ? 'consent_blocked' : 'routing_failure'}`,
      payload: {},
      response: null,
      error: isConsentBlock ? 'Recipient has opted out' : err.message || 'Routing failed',
    };
    eventBus.emit(errorEvent);
    observeFailure(category, errorEvent.providerId, isConsentBlock ? 'CONSENT_BLOCKED' : 'ROUTING_FAILED');
    observe(errorEvent);
    return res.status(isConsentBlock ? 403 : 503).json({ error: errorEvent.error, id: errorEvent.id });
  }
});

// ----------------------------------------------------
// DEVELOPER PORTAL — self-service account, API keys, transaction history.
// Consumed by apps/developer-portal. Session auth (Bearer JWT), not the
// server-to-server API-key auth the traffic routes above use.
// ----------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'app';
}

app.post('/v1/portal/auth/signup', async (req: Request, res: Response) => {
  const { companyName, email, password } = req.body;
  if (!companyName || !email || !password) {
    return res.status(400).json({ error: 'companyName, email, and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const baseSlug = slugify(companyName);
    let slug = baseSlug;
    let suffix = 1;
    while (await applicationRepository.findBySlug(slug)) {
      slug = `${baseSlug}-${++suffix}`;
    }

    const application = await applicationRepository.create({
      name: companyName,
      slug,
      environment: 'development',
    });

    const existingUser = await userRepository.findByApplicationAndEmail(application.id, email);
    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const user = await userRepository.create({
      applicationId: application.id,
      email,
      passwordHash: hashPassword(password),
    });

    const apiKey = generateApiKey();
    await apiKeyRepository.create({
      applicationId: application.id,
      keyHash: apiKey.hash,
      prefix: apiKey.prefix,
      environment: 'test',
    });

    // A new signup is useless without a tenant to send traffic under —
    // resolveTenantContext rejects every /v1/api/gateway/* request until one
    // exists and is linked. Provision a default one so the account is usable
    // immediately; additional tenants can still be created later.
    const defaultTenant = await tenantRepository.create({
      name: 'Default',
      slug: `${slug}-default`,
    });
    await tenantApplicationLinkRepository.link(defaultTenant.id, application.id);

    const token = signPortalToken({ userId: user.id, applicationId: application.id, email: user.email }, PORTAL_JWT_SECRET);

    return res.status(201).json({
      token,
      application: { id: application.id, name: application.name, slug: application.slug },
      apiKey: { prefix: apiKey.prefix, raw: apiKey.raw },
      tenant: { id: defaultTenant.id, name: defaultTenant.name, slug: defaultTenant.slug },
    });
  } catch (err: any) {
    logger.error('portal signup failed', {
      operation: 'portal-signup',
      errorCode: 'SIGNUP_FAILED',
      status: 'failed',
      errorMessage: err?.message,
      stack: err?.stack,
    });
    return res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/v1/portal/auth/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  // email is now enforced globally unique (idx_users_email — see
  // schema/users.ts), so findByEmail resolves at most one account.
  const user = await userRepository.findByEmail(email);
  if (user?.passwordHash && verifyPassword(password, user.passwordHash)) {
    const application = await applicationRepository.findById(user.applicationId);
    if (application) {
      const token = signPortalToken({ userId: user.id, applicationId: application.id, email: user.email }, PORTAL_JWT_SECRET);
      return res.json({
        token,
        application: { id: application.id, name: application.name, slug: application.slug },
      });
    }
  }

  return res.status(401).json({ error: 'Invalid email or password' });
});

app.get('/v1/portal/me', requirePortalAuth, async (req: Request, res: Response) => {
  const portalUser = (req as Request & { portalUser?: PortalTokenPayload }).portalUser!;
  const application = await applicationRepository.findById(portalUser.applicationId);
  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }
  return res.json({
    user: { id: portalUser.userId, email: portalUser.email },
    application: { id: application.id, name: application.name, slug: application.slug, environment: application.environment },
  });
});

app.get('/v1/portal/tenants', requirePortalAuth, async (req: Request, res: Response) => {
  const portalUser = (req as Request & { portalUser?: PortalTokenPayload }).portalUser!;
  const tenants = await tenantRepository.findActiveByApplicationId(portalUser.applicationId);
  return res.json({
    tenants: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
  });
});

app.get('/v1/portal/api-keys', requirePortalAuth, async (req: Request, res: Response) => {
  const portalUser = (req as Request & { portalUser?: PortalTokenPayload }).portalUser!;
  const keys = await apiKeyRepository.findByApplicationId(portalUser.applicationId);
  return res.json({
    apiKeys: keys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      environment: k.environment,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
    })),
  });
});

app.post('/v1/portal/api-keys', requirePortalAuth, async (req: Request, res: Response) => {
  const portalUser = (req as Request & { portalUser?: PortalTokenPayload }).portalUser!;
  const environment = req.body?.environment === 'live' ? 'live' : 'test';
  const apiKey = generateApiKey();
  const created = await apiKeyRepository.create({
    applicationId: portalUser.applicationId,
    keyHash: apiKey.hash,
    prefix: apiKey.prefix,
    environment,
  });
  // The raw key is only ever shown here, once, at creation time.
  return res.status(201).json({ id: created.id, prefix: apiKey.prefix, raw: apiKey.raw, environment });
});

app.delete('/v1/portal/api-keys/:id', requirePortalAuth, async (req: Request, res: Response) => {
  const portalUser = (req as Request & { portalUser?: PortalTokenPayload }).portalUser!;
  const key = await apiKeyRepository.findById(req.params.id);
  if (!key || key.applicationId !== portalUser.applicationId) {
    return res.status(404).json({ error: 'API key not found' });
  }
  await apiKeyRepository.revoke(req.params.id);
  return res.status(204).send();
});

app.get('/v1/portal/transactions', requirePortalAuth, async (req: Request, res: Response) => {
  const portalUser = (req as Request & { portalUser?: PortalTokenPayload }).portalUser!;
  const application = await applicationRepository.findById(portalUser.applicationId);
  if (!application) {
    return res.status(404).json({ error: 'Application not found' });
  }
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const transactions = await transactionRepository.findByAppId(application.slug, limit);
  return res.json({ transactions });
});

// ----------------------------------------------------
// HOSTED CHECKOUT SESSIONS
// A business creates a session server-side with its real API key; the
// customer's browser (apps/checkout) only ever sees the opaque public token
// below, never the API key. See packages/database/src/schema/checkout-sessions.ts.
// ----------------------------------------------------

const CHECKOUT_SESSION_TTL_MS = 30 * 60_000; // 30 minutes
const CHECKOUT_BASE_URL = process.env.CHECKOUT_BASE_URL || 'http://localhost:5174';

app.post('/v1/api/gateway/checkout-sessions', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { tenantId } = authContext(req);
  const { amount, currency, successUrl, cancelUrl, metadata } = req.body;

  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }
  if (!amount || !currency) {
    return res.status(400).json({ error: 'amount and currency are required' });
  }

  const token = randomUUID().replace(/-/g, '');
  const session = await checkoutSessionRepository.create({
    token,
    appId,
    tenantId,
    amount: String(amount),
    currency,
    successUrl: successUrl || null,
    cancelUrl: cancelUrl || null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    expiresAt: new Date(Date.now() + CHECKOUT_SESSION_TTL_MS),
  });

  return res.status(201).json({
    id: session.id,
    token: session.token,
    checkoutUrl: `${CHECKOUT_BASE_URL}/?session=${session.token}`,
    expiresAt: session.expiresAt,
  });
});

// Public — no API key. The session token is itself the capability: it's
// single-use, expiring, and scoped to exactly the amount/currency/app it
// was created for, so the browser never needs the application's secret key.
app.get('/v1/checkout/sessions/:token', async (req: Request, res: Response) => {
  await checkoutSessionRepository.markExpiredIfPast(req.params.token);
  const session = await checkoutSessionRepository.findByToken(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'Checkout session not found' });
  }
  const application = await applicationRepository.findBySlug(session.appId);
  return res.json({
    id: session.id,
    status: session.status,
    amount: Number(session.amount),
    currency: session.currency,
    applicationName: application?.name || session.appId,
  });
});

app.post('/v1/checkout/sessions/:token/pay', async (req: Request, res: Response) => {
  await checkoutSessionRepository.markExpiredIfPast(req.params.token);
  const session = await checkoutSessionRepository.findByToken(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'Checkout session not found' });
  }
  if (session.status !== 'pending') {
    return res.status(409).json({ error: `Checkout session is already ${session.status}` });
  }

  const { paymentMethod, phoneNumber } = req.body ?? {};
  // paymentToken / country / metadata used to be dropped here too (gap
  // register C1/E1) — validated and forwarded now.
  const extras = parsePaymentExtras(req.body);
  if (!extras.ok) return invalidRequest(res, extras.field, extras.message);
  const { paymentToken, country } = extras.value;

  // This route is public (the session token is the capability), so the
  // shopper-supplied metadata is merged UNDER the merchant's own session
  // metadata (set server-side at session creation): a shopper can add
  // fields but can never override one the merchant set.
  let sessionMetadata: Record<string, unknown> | undefined;
  if (session.metadata) {
    try {
      const parsed = typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata;
      if (isPlainObject(parsed)) sessionMetadata = parsed;
    } catch {
      sessionMetadata = undefined;
    }
  }
  const metadata = extras.value.metadata || sessionMetadata
    ? { ...(extras.value.metadata ?? {}), ...(sessionMetadata ?? {}) }
    : undefined;

  // One payment per checkout session, keyed in the transactions table's own
  // unique index: two concurrent /pay calls can no longer both reach a
  // provider — the second loses the allocation (409) BEFORE any charge,
  // instead of (as before) both charging and only the second *write* being
  // rejected. The key is derived from the session id (never the session
  // token, which is a bearer capability and must not be sent to providers).
  const sessionPaymentKey = `checkout_session_${session.id}`;
  const currency = session.currency;

  let allocation: PaymentAllocation;
  try {
    allocation = await allocatePaymentTransaction({
      appId: session.appId,
      tenantId: session.tenantId,
      amount: String(Number(session.amount)),
      currency,
      paymentMethod: paymentMethod || 'card',
      idempotencyKey: sessionPaymentKey,
      metadata: metadata ?? null,
    });
  } catch (err) {
    logger.error('checkout payment transaction allocation failed', {
      operation: 'checkout-allocate-transaction',
      applicationId: session.appId,
      errorCode: 'PAYMENT_RECORD_UNAVAILABLE',
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(503).json({ error: 'Payment failed', cancelUrl: session.cancelUrl });
  }
  if (allocation.kind === 'conflict') {
    return res.status(409).json({
      error: 'A payment for this checkout session is already in progress or completed',
      paymentTransactionId: allocation.existing.id,
    });
  }
  const paymentTransactionId = allocation.transaction.id;

  try {
    const routed = await routingEngine.routePayment(session.appId, {
      amount: Number(session.amount),
      currency,
      paymentMethod: paymentMethod || 'card',
      phoneNumber,
      paymentToken,
      country,
      metadata,
      idempotencyKey: sessionPaymentKey,
      paymentTransactionId,
    });
    // Phase 7: the tenant is the one the merchant authenticated as when it
    // created the session (stored server-side on the session row).
    const event = scopeEvent(routed, { tenantId: session.tenantId });

    await recordPaymentOutcome(paymentTransactionId, event, currency);

    // Single-use: only the first payment attempt against this session can
    // mark it completed. (The allocation above is what now stops a
    // concurrent second charge; this remains the session-state guard.)
    const completed = await checkoutSessionRepository.markCompleted(session.token, event.id);
    if (!completed) {
      return res.status(409).json({ error: 'Checkout session was already completed' });
    }

    eventBus.emit(event);
    observe(event);

    return res.json({
      status: event.status,
      id: event.id,
      paymentTransactionId,
      successUrl: session.successUrl,
    });
  } catch (err: any) {
    await recordPaymentRoutingFailure(paymentTransactionId, 'failed_route', err instanceof Error ? err.message : String(err), metadata);
    return res.status(503).json({ error: 'Payment failed', cancelUrl: session.cancelUrl });
  }
});

// ----------------------------------------------------
// PROVIDER CAPABILITY QUERY API
// ----------------------------------------------------
// Consuming applications can discover available providers and their capabilities.

app.get('/v1/api/gateway/providers', mw.apiKey, resolveTenantContext, (req: Request, res: Response) => {
  const { category, capability, currency } = req.query;

  if (category && typeof category === 'string') {
    const caps = capability ? [capability as string] : [];
    const cur = currency ? currency as string : undefined;
    const matches = registry.findByCategoryAndCapabilities(
      category as 'payment' | 'messaging' | 'other',
      caps,
      cur,
    );
    return res.json({ providers: matches, count: matches.length });
  }

  // Return all providers with their management views
  const views = registry.getAllManagementViews();
  return res.json({ providers: views, count: views.length });
});

// ----------------------------------------------------
// INBOUND PROVIDER WEBHOOKS — Phase 4 durable pipeline
// ----------------------------------------------------
// Gap register B8/C5/D7: the old route marked a delivery "seen" in a
// per-process in-memory Map keyed only by body.id (no provider — cross-
// provider id collisions possible), answered 200, and THEN fired off the
// enqueues without awaiting them. An enqueue failure lost the webhook, the
// provider's retry got 409 from the Map, and a restart forgot everything.
//
// The pipeline is now, strictly in order:
//   1 receive
//   2 authenticate (HMAC over the exact raw request bytes, timing-safe)
//   3 validate shape (JSON object with a provider event id)
//   4 identify provider (must be registered)
//   5 identify application   6 identify tenant
//   7 persist durably + 8 enforce uniqueness — ONE statement:
//        INSERT INTO webhook_events ... ON CONFLICT (provider_id,
//        provider_event_id) DO NOTHING RETURNING *
//      Postgres's unique index is the dedup mechanism. Nothing in memory is.
//   9 enqueue (awaited)
//  10 acknowledge — 200 ONLY once the event is durably recorded AND enqueued.
// A duplicate of an already-enqueued event gets 200 without re-enqueueing.
// A DB failure at step 7, or an enqueue failure at step 9, gets 503 so the
// provider retries; a persisted-but-unenqueued event is finished either by
// that retry or by the worker's webhook_event_recovery sweeper.

const MAX_PROVIDER_EVENT_ID_LENGTH = 255;

function extractProviderEventId(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>).id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROVIDER_EVENT_ID_LENGTH) return null;
  return trimmed;
}

function boundedString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 255 ? v : null;
}

/**
 * Steps 5-6 — identify application + tenant from a SERVER-SIDE source of
 * truth only.
 *
 * Phase 7 (gap register GW-1.1). Phase 4 made the platform's own
 * transactions row authoritative when one matched, but still FELL BACK to
 * the payload's self-declared `metadata.appId` / `metadata.tenantId` when
 * none did. The payload is authenticated only by the single platform-wide
 * WEBHOOK_HMAC_SECRET (shared by every provider — native per-provider
 * signatures are still unverified, E10), so that fallback let any holder of
 * that one secret attribute a webhook to any application/tenant it named.
 * Body metadata is now never used for attribution. The owner is taken from
 * the platform row the webhook refers to:
 *   1. the provider's charge/intent id, matched on transactions
 *      .provider_transaction_id for THIS provider only (a colliding id from
 *      another provider can't borrow that provider's row — D16) —
 *      `payment_intent` first (Stripe charge.* events), then `object.id`;
 *   2. else the platform's own row id the platform itself attached to the
 *      charge (`metadata.bisPaymentTransactionId`, a UUID the gateway
 *      allocated) — accepted only for a row of this provider (or one not yet
 *      assigned a provider) that has no provider id yet or the same one.
 * No match → unattributed (null/null): the webhook is still durably recorded
 * and processed (identity is provider-level), but it is not attributed to
 * any tenant — and an event with no tenant is never dispatched to any
 * tenant's webhook endpoint.
 */
const WEBHOOK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function identifyWebhookOwner(
  provider: string,
  body: any,
): Promise<{ appId: string | null; tenantId: string | null; source: 'transaction' | 'unattributed' }> {
  const object = body?.data?.object ?? {};
  const candidates = [boundedString(object?.payment_intent), boundedString(object?.id)].filter(
    (v, idx, arr): v is string => v !== null && arr.indexOf(v) === idx,
  );
  try {
    for (const providerTxId of candidates) {
      const tx = await transactionRepository.findByProviderTransactionId(providerTxId, provider);
      if (tx && tx.providerId === provider) {
        return { appId: tx.appId, tenantId: tx.tenantId, source: 'transaction' };
      }
    }
    const bisTxId = boundedString(object?.metadata?.bisPaymentTransactionId);
    if (bisTxId && WEBHOOK_UUID_RE.test(bisTxId)) {
      const tx = await transactionRepository.findById(bisTxId);
      if (
        tx &&
        (tx.providerId === provider || tx.providerId === 'unassigned') &&
        (!tx.providerTransactionId || candidates.includes(tx.providerTransactionId))
      ) {
        return { appId: tx.appId, tenantId: tx.tenantId, source: 'transaction' };
      }
    }
  } catch {
    // Attribution lookup only; a DB problem will surface at the persist step.
  }
  return { appId: null, tenantId: null, source: 'unattributed' };
}

function webhookReject(res: Response, provider: string, status: number, errorCode: string, error: string) {
  metrics.increment('webhookFailures');
  logger.error('webhook rejected', { operation: 'webhook', providerId: provider, errorCode, status: 'failed' });
  return res.status(status).json({ error });
}

app.post('/v1/api/webhooks/:provider', asyncHandler(async (req: Request, res: Response) => {
  // 1. receive
  const provider = req.params.provider;
  setContextField('providerId', provider);
  const signature = req.header('x-webhook-signature');

  // 2. authenticate
  const webhookSecret = process.env.WEBHOOK_HMAC_SECRET;
  if (!webhookSecret) {
    return webhookReject(res, provider, 503, 'NO_WEBHOOK_SECRET', 'Webhook verification not configured');
  }
  if (!signature) {
    return webhookReject(res, provider, 401, 'MISSING_SIGNATURE', 'Missing webhook signature');
  }
  // Verify over the exact bytes received (express.json's verify hook keeps
  // them on req.rawBody) — a re-serialised JSON.stringify(req.body) can
  // differ from what the sender signed. Falls back only if absent.
  const stashed = (req as Request & { rawBody?: Buffer }).rawBody;
  const rawBody = stashed ? stashed.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return webhookReject(res, provider, 401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }

  // 3. validate shape — the provider event id IS the durable identity; a
  // webhook without one could never be de-duplicated, so it is refused.
  const providerEventId = extractProviderEventId(req.body);
  if (!providerEventId) {
    return webhookReject(
      res,
      provider,
      400,
      'INVALID_WEBHOOK_PAYLOAD',
      `Webhook payload must be a JSON object with a non-empty "id" (provider event id, max ${MAX_PROVIDER_EVENT_ID_LENGTH} chars)`,
    );
  }

  // 4. identify provider
  if (!registry.getProvider(provider)) {
    return webhookReject(res, provider, 401, 'UNKNOWN_PROVIDER', 'Unknown provider');
  }

  // 5-6. identify application + tenant (server-side source of truth only)
  const { appId, tenantId, source: ownerSource } = await identifyWebhookOwner(provider, req.body);
  if (ownerSource === 'unattributed') {
    logger.info('webhook not attributable to a platform transaction — recorded without application/tenant', {
      operation: 'webhook',
      providerId: provider,
      status: 'unattributed',
    });
  }

  // 7-9. persist durably (uniqueness enforced by Postgres) → enqueue
  const { queue } = await getGatewayQueue();
  const outcome = await ingestWebhook(
    { store: webhookEventRepository, enqueue: (type, payload) => queue.enqueue(type, payload) },
    {
      providerId: provider,
      providerEventId,
      appId,
      tenantId,
      eventType: boundedString(req.body?.type),
      payload: req.body,
      rawBody,
      signature,
    },
  );

  // 10. acknowledge — only what is durably recorded and enqueued
  switch (outcome.kind) {
    case 'accepted':
    case 'recovered': {
      logger.info('webhook received', { operation: 'webhook', providerId: provider, status: 'success' });
      // Monitoring only; processing is driven by the enqueued jobs.
      eventBus.emit({
        id: `wh_${Date.now()}_${randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        appId: 'webhook',
        category: 'payment' as const,
        providerId: provider,
        status: 'success' as const,
        latency: 0,
        cost: 0,
        decisionReason: 'webhook_received',
        payload: req.body,
        response: null,
      });
      return res.json({ received: true, webhookEventId: outcome.event.id });
    }
    case 'duplicate':
      logger.warn('webhook duplicate — already durably recorded, acknowledged without re-enqueue', {
        operation: 'webhook',
        providerId: provider,
        errorCode: 'DUPLICATE_WEBHOOK',
        status: 'success',
      });
      return res.json({ received: true, duplicate: true, webhookEventId: outcome.event.id });
    case 'in_flight':
      res.setHeader('Retry-After', '5');
      return webhookReject(res, provider, 503, 'WEBHOOK_IN_FLIGHT', 'Webhook is being recorded by a concurrent delivery; retry later');
    case 'persist_failed':
      res.setHeader('Retry-After', '5');
      logger.error('webhook durable persist failed', { operation: 'webhook', providerId: provider, errorCode: 'WEBHOOK_PERSIST_FAILED', status: 'failed' });
      return webhookReject(res, provider, 503, 'WEBHOOK_PERSIST_FAILED', 'Webhook could not be durably recorded; retry later');
    case 'enqueue_failed':
      res.setHeader('Retry-After', '5');
      return webhookReject(res, provider, 503, 'WEBHOOK_ENQUEUE_FAILED', 'Webhook recorded but could not be queued for processing; retry later');
  }
}));

// The gateway's handle on the platform's real, shared job queue
// (@company/workers) — the same JobQueue/KVStore abstraction the worker
// service uses (services/worker/src/index.ts). With B1 fixed, createStore()
// now really returns a RedisStore whenever Redis is reachable, so jobs
// enqueued here reach the worker. If Redis genuinely cannot be reached it
// still falls back to a per-process in-memory store (loud warning) — jobs in
// it never reach the worker (gap register B2), but webhooks no longer depend
// on that: every accepted webhook is a durable webhook_events row, and the
// worker's webhook_event_recovery sweeper re-enqueues any row no consumer
// ever picked up.
let _gatewayQueuePromise: Promise<{
  queue: JobQueue;
  store: KVStore;
  keys: Keys;
  config: WorkerConfig;
}> | null = null;

function getGatewayQueue() {
  if (!_gatewayQueuePromise) {
    _gatewayQueuePromise = (async () => {
      const config = createWorkerConfig();
      const store = await createStore(config.redisUrl);
      const keys = createKeys(config.queuePrefix);
      return { queue: new JobQueue(store, keys, config), store, keys, config };
    })();
  }
  return _gatewayQueuePromise;
}

// Exposed only so packages/simulation's test harness can attach a worker to
// the exact same store/keys this gateway enqueues into — see
// packages/simulation/src/harness.ts. Not used by any production code path.
export async function getGatewayQueueForTests() {
  return getGatewayQueue();
}

// Exposed only so packages/simulation's tests can force an immediate
// outbound-webhook delivery attempt instead of waiting on the real 5s
// interval timer. Not used by any production code path.
export function getWebhookDeliveryForTests() {
  return webhookDelivery;
}

// ----------------------------------------------------
// DASHBOARD MANAGEMENT ENDPOINTS
// ----------------------------------------------------
// Every mutating/sensitive route below already has its own requireAdmin
// (ADMIN_API_TOKEN via x-admin-token, checked further up in this file) —
// there used to also be a blanket app.use('/api/dashboard', mw.admin) here
// checking a second, incompatible mechanism (PLATFORM_ADMIN_KEY via
// x-admin-key/authorization). Since it ran first in the middleware chain,
// it rejected every request — including to the intentionally-public
// GET /providers below — before requireAdmin ever got a chance, no matter
// what admin token was supplied. Removed along with the now-fully-dead
// checkAdmin()/adminKey/mw.admin (see auth.ts).

app.get('/api/dashboard/providers', (req: Request, res: Response) => {
  return res.json(registry.getAllManagementViews());
});

app.patch('/api/dashboard/providers/:id', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const updates = req.body;

  const updatedConfig = registry.updateProviderConfig(id, updates);
  if (!updatedConfig) {
    return res.status(404).json({ error: `Provider '${id}' not found` });
  }

  const sseMsg = {
    id: 'config_' + Date.now(),
    timestamp: new Date().toISOString(),
    appId: 'system-dashboard',
    category: 'other' as const,
    providerId: id,
    status: 'success' as const,
    latency: 1,
    cost: 0,
    decisionReason: `System Registry Config Updated: Status=${updatedConfig.status}, Weight=${updatedConfig.weight}`,
    payload: updates,
    response: updatedConfig
  };
  eventBus.emit(sseMsg);

  return res.json(updatedConfig);
});

// ----------------------------------------------------
// PROVIDER MANAGEMENT SURFACE
// ----------------------------------------------------

app.get('/api/dashboard/providers/:id/management', requireAdmin, (req: Request, res: Response) => {
  const view = registry.getManagementView(req.params.id);
  if (!view) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  return res.json(view);
});

app.patch('/api/dashboard/providers/:id/management', requireAdmin, (req: Request, res: Response) => {
  const updated = registry.updateManagement(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  return res.json(updated);
});

app.get('/api/dashboard/providers/:id/secrets', requireAdmin, (req: Request, res: Response) => {
  const secrets = registry.getSecrets(req.params.id);
  if (secrets === null) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  return res.json(secrets);
});

app.post('/api/dashboard/providers/:id/secrets', requireAdmin, (req: Request, res: Response) => {
  const { field, label, value } = req.body || {};
  if (!field || !label || !value) {
    return res.status(400).json({ error: 'Missing parameters: field, label, and value are required' });
  }
  const meta = registry.addSecret(req.params.id, { field, label, value });
  if (!meta) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  persistProviderSecretsAsync(req.params.id);
  return res.status(201).json(meta);
});

app.delete('/api/dashboard/providers/:id/secrets/:secretId', requireAdmin, (req: Request, res: Response) => {
  const removed = registry.deleteSecret(req.params.id, req.params.secretId);
  if (!removed) {
    return res.status(404).json({ error: `Secret '${req.params.secretId}' not found for provider '${req.params.id}'` });
  }
  persistProviderSecretsAsync(req.params.id);
  return res.json({ success: true });
});

app.get('/api/dashboard/providers/:id/routing', requireAdmin, (req: Request, res: Response) => {
  const rules = registry.getRoutingRules(req.params.id);
  if (rules === null) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  return res.json(rules);
});

app.post('/api/dashboard/providers/:id/routing', requireAdmin, (req: Request, res: Response) => {
  const { match, target, description, enabled } = req.body || {};
  if (!match || !target) {
    return res.status(400).json({ error: 'Missing parameters: match and target are required' });
  }
  const rule = registry.addRoutingRule(req.params.id, {
    match,
    target,
    description,
    enabled: enabled !== false
  });
  if (!rule) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  return res.status(201).json(rule);
});

app.patch('/api/dashboard/providers/:id/routing/:ruleId', requireAdmin, (req: Request, res: Response) => {
  const updated = registry.updateRoutingRule(req.params.id, req.params.ruleId, req.body || {});
  if (!updated) {
    return res.status(404).json({ error: `Routing rule '${req.params.ruleId}' not found for provider '${req.params.id}'` });
  }
  return res.json(updated);
});

app.delete('/api/dashboard/providers/:id/routing/:ruleId', requireAdmin, (req: Request, res: Response) => {
  const removed = registry.deleteRoutingRule(req.params.id, req.params.ruleId);
  if (!removed) {
    return res.status(404).json({ error: `Routing rule '${req.params.ruleId}' not found for provider '${req.params.id}'` });
  }
  return res.json({ success: true });
});

app.post('/api/dashboard/providers/:id/health-check', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await registry.runHealthCheck(req.params.id);
    if (!result) {
      return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
    }
    metrics.setProviderHealth(result.providerId, result.status);
    logger.info('provider health check', {
      operation: 'health-check',
      providerId: result.providerId,
      status: result.status,
      latency: result.latencyMs,
      errorCode: result.errorMessage ? 'HEALTH_DEGRADED' : undefined,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/dashboard/providers/health-checks', requireAdmin, async (req: Request, res: Response) => {
  try {
    const results = await registry.runHealthChecks();
    results.forEach((r) => metrics.setProviderHealth(r.providerId, r.status));
    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/logs', requireAdmin, (req: Request, res: Response) => {
  return res.json(eventBus.getHistory());
});

// ----------------------------------------------------
// TRANSACTIONAL OUTBOX — dead letters (Phase 5, gap register D10)
// ----------------------------------------------------
// An outbox event that exhausted its retries (or kept crashing its worker)
// is moved to `dead` — never dropped. These routes list them and replay
// them. A replay is one conditional UPDATE ... WHERE status = 'dead', so a
// double-clicked or concurrent replay re-dispatches the row once, and a row
// that already completed can never be replayed.

app.get('/api/dashboard/outbox', requireAdmin, asyncHandler(async (_req: Request, res: Response) => {
  return res.json({ counts: await outboxEventRepository.countByStatus() });
}));

app.get('/api/dashboard/outbox/dead', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  const rows = await outboxEventRepository.listDead({
    appId: typeof req.query.appId === 'string' ? req.query.appId : undefined,
    eventType: typeof req.query.eventType === 'string' ? req.query.eventType : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  return res.json({ data: rows });
}));

// Registered BEFORE /outbox/:id/replay on purpose: Express matches routes in
// registration order, and the parameterised route would otherwise capture
// this path as :id = 'dead' (and reject it as a malformed id with 400).
app.post('/api/dashboard/outbox/dead/replay', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { appId?: unknown; eventType?: unknown; limit?: unknown };
  const limit = Number(body.limit);
  const rows = await outboxEventRepository.replayDeadBatch({
    appId: typeof body.appId === 'string' ? body.appId : undefined,
    eventType: typeof body.eventType === 'string' ? body.eventType : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  logger.warn('outbox dead letters replayed by operator', { operation: 'outbox-replay', status: 'success', count: rows.length });
  return res.json({ replayed: rows.length, ids: rows.map((r) => r.id) });
}));

app.post('/api/dashboard/outbox/:id/replay', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid outbox event id' });
  }
  const replayed = await outboxEventRepository.replayDead(id);
  if (replayed) {
    logger.warn('outbox dead letter replayed by operator', { operation: 'outbox-replay', status: 'success' });
    return res.json({ replayed: true, event: replayed });
  }
  const current = await outboxEventRepository.findById(id);
  if (!current) return res.status(404).json({ error: 'outbox event not found' });
  return res.status(409).json({ replayed: false, error: `outbox event is '${current.status}', only 'dead' events can be replayed`, status: current.status });
}));

// ----------------------------------------------------
// PAYMENT RECONCILIATION (Phase 6, gap register D4 / PHASE3-02)
// ----------------------------------------------------
// Payments whose outcome the platform does NOT know — a provider timeout /
// lost response ('unknown'), or a row the reconciliation job escalated
// ('requires_reconciliation': stuck in 'processing' after a crash, or an
// ambiguous outcome no provider status check could resolve). Neither route
// ever calls a provider: re-sending a possibly-already-processed charge is
// exactly the double-charge the certification spec prohibits. An operator
// verifies the real outcome out of band (provider dashboard) and records it.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reconciliationView(row: PaymentTransactionRow, now = Date.now()) {
  const since = row.reconciliationRequiredAt ?? row.outcomeUnknownAt ?? row.updatedAt;
  return {
    paymentTransactionId: row.id,
    appId: row.appId,
    tenantId: row.tenantId,
    providerId: row.providerId,
    providerTransactionId: row.providerTransactionId,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    outcomeUnknownAt: row.outcomeUnknownAt,
    reconciliationRequiredAt: row.reconciliationRequiredAt,
    reconciliationReason: row.reconciliationReason,
    reconciliationCheckedAt: row.reconciliationCheckedAt,
    reconciliationCheckCount: row.reconciliationCheckCount,
    reconciliationLastCheck: row.reconciliationLastCheck,
    stuckForSeconds: Math.max(0, Math.round((now - new Date(since).getTime()) / 1000)),
    ageSeconds: Math.max(0, Math.round((now - new Date(row.createdAt).getTime()) / 1000)),
  };
}

app.get('/api/dashboard/payments/reconciliation', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  const rows = await transactionRepository.listRequiringReconciliation({
    appId: typeof req.query.appId === 'string' ? req.query.appId : undefined,
    includeUnknown: req.query.includeUnknown === 'true',
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  const counts = await transactionRepository.countUnresolvedByStatus();
  return res.json({ counts, data: rows.map((r) => reconciliationView(r)) });
}));

app.post('/api/dashboard/payments/reconciliation/:id/resolve', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'invalid payment transaction id' });
  const body = (req.body ?? {}) as { status?: unknown; providerTransactionId?: unknown; note?: unknown; resolvedBy?: unknown };
  const status = body.status;
  if (status !== 'success' && status !== 'failed' && status !== 'cancelled') {
    return invalidRequest(res, 'status', "status must be one of 'success', 'failed', 'cancelled' (the outcome verified with the provider)");
  }
  if (typeof body.note !== 'string' || body.note.trim() === '' || body.note.length > 2000) {
    return invalidRequest(res, 'note', 'note is required (how the outcome was verified), at most 2000 characters');
  }
  // The admin token carries no identity (gap register C7), so the operator
  // names themselves; recorded verbatim for the audit trail.
  if (typeof body.resolvedBy !== 'string' || body.resolvedBy.trim() === '' || body.resolvedBy.length > 200) {
    return invalidRequest(res, 'resolvedBy', 'resolvedBy is required, at most 200 characters');
  }
  const providerTransactionId = body.providerTransactionId;
  if (providerTransactionId !== undefined && (typeof providerTransactionId !== 'string' || providerTransactionId === '' || providerTransactionId.length > 255)) {
    return invalidRequest(res, 'providerTransactionId', 'providerTransactionId must be a non-empty string of at most 255 characters');
  }
  const result = await transactionRepository.transitionStatus(id, status, {
    // Only an ambiguous payment can be resolved here — never a recorded outcome.
    from: ['unknown', 'requires_reconciliation'],
    fillProviderTransactionId: typeof providerTransactionId === 'string' ? providerTransactionId : undefined,
    resolution: {
      source: 'operator',
      resolvedBy: body.resolvedBy.trim(),
      note: body.note.trim(),
      resolvedStatus: status,
      providerTransactionId: providerTransactionId ?? null,
    },
  });
  if (result.outcome === 'not_found') return res.status(404).json({ error: 'payment transaction not found' });
  if (result.outcome === 'rejected') {
    return res.status(409).json({
      resolved: false,
      error: `payment transaction is '${result.currentStatus}'; only 'unknown' or 'requires_reconciliation' payments can be resolved by an operator`,
      status: result.currentStatus,
    });
  }
  logger.warn('payment reconciled by operator', {
    operation: 'payment-reconcile',
    status: 'success',
    paymentTransactionId: id,
    resolvedStatus: status,
  });
  return res.json({ resolved: true, transaction: reconciliationView(result.transaction) });
}));

// ----------------------------------------------------
// HELD INBOUND MESSAGES (Phase 8, gap register A1-A4)
// ----------------------------------------------------
// Inbound messages on a shared number that could not be attributed to
// exactly one owner (application → tenant → supplier) are quarantined
// platform-side instead of being delivered to a guessed tenant (the
// pre-Phase-8 behaviour) or dropped. Only BIS staff (requireAdmin) can see
// them. An operator attributes a held message to ONE of the owners the
// platform itself recorded as candidates; only then is it delivered (and
// any STOP/YES/NO applied) — to that owner — by the inbound worker.

function inboundHoldView(row: InboundMessageHold) {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    providerId: row.providerId,
    customerPhone: row.customerPhone,
    businessNumber: row.businessNumber,
    channel: row.channel,
    content: row.content,
    keyword: row.keyword,
    senderOptOutApplied: row.senderOptOutApplied,
    candidates: row.candidates,
    resolvedAppId: row.resolvedAppId,
    resolvedTenantId: row.resolvedTenantId,
    resolvedSupplierId: row.resolvedSupplierId,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

app.get('/api/dashboard/inbound-holds', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (!['pending', 'resolved', 'delivered', 'discarded'].includes(status)) {
    return invalidRequest(res, 'status', "status must be one of 'pending', 'resolved', 'delivered', 'discarded'");
  }
  const rows = await inboundMessageHoldRepository.list({ status, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined });
  const counts = await inboundMessageHoldRepository.countByStatus();
  return res.json({ counts, data: rows.map(inboundHoldView) });
}));

function operatorMeta(res: Response, body: { note?: unknown; resolvedBy?: unknown }): { note: string; resolvedBy: string } | null {
  if (typeof body.note !== 'string' || body.note.trim() === '' || body.note.length > 2000) {
    invalidRequest(res, 'note', 'note is required (how the owner was established), at most 2000 characters');
    return null;
  }
  // The admin token carries no identity (gap register C7), so the operator
  // names themselves; recorded verbatim for the audit trail.
  if (typeof body.resolvedBy !== 'string' || body.resolvedBy.trim() === '' || body.resolvedBy.length > 200) {
    invalidRequest(res, 'resolvedBy', 'resolvedBy is required, at most 200 characters');
    return null;
  }
  return { note: body.note.trim(), resolvedBy: body.resolvedBy.trim() };
}

app.post('/api/dashboard/inbound-holds/:id/resolve', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'invalid hold id' });
  const body = (req.body ?? {}) as { appId?: unknown; tenantId?: unknown; supplierId?: unknown; note?: unknown; resolvedBy?: unknown };
  if (typeof body.appId !== 'string' || body.appId === '') return invalidRequest(res, 'appId', 'appId is required');
  if (typeof body.tenantId !== 'string' || body.tenantId === '') return invalidRequest(res, 'tenantId', 'tenantId is required');
  if (body.supplierId !== undefined && body.supplierId !== null && typeof body.supplierId !== 'string') {
    return invalidRequest(res, 'supplierId', 'supplierId must be a string or null');
  }
  const meta = operatorMeta(res, body);
  if (!meta) return;
  const result = await inboundMessageHoldRepository.resolve(
    id,
    { appId: body.appId, tenantId: body.tenantId, supplierId: (body.supplierId as string | null | undefined) ?? null },
    meta,
  );
  if (result.outcome === 'not_found') return res.status(404).json({ error: 'hold not found' });
  if (result.outcome === 'not_pending') {
    return res.status(409).json({ resolved: false, error: `hold is '${result.status}'; only a pending hold can be attributed`, status: result.status });
  }
  if (result.outcome === 'not_a_candidate') {
    return res.status(409).json({
      resolved: false,
      error: 'the chosen owner is not one of the owners this message could belong to',
      candidates: result.candidates,
    });
  }
  // Delivery happens in the worker (same code path as a routed message),
  // reading the owner from the hold row — never from this job payload.
  const { queue } = await getGatewayQueue();
  await queue.enqueue('inbound_message', { providerId: result.hold.providerId, holdId: result.hold.id });
  logger.warn('held inbound message attributed by operator', {
    operation: 'inbound-hold-resolve',
    status: 'success',
    holdId: id,
    applicationId: body.appId,
    tenantId: body.tenantId,
  });
  return res.json({ resolved: true, hold: inboundHoldView(result.hold) });
}));

app.post('/api/dashboard/inbound-holds/:id/discard', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!UUID_PATTERN.test(id)) return res.status(400).json({ error: 'invalid hold id' });
  const meta = operatorMeta(res, (req.body ?? {}) as { note?: unknown; resolvedBy?: unknown });
  if (!meta) return;
  const row = await inboundMessageHoldRepository.discard(id, meta);
  if (!row) return res.status(409).json({ discarded: false, error: 'hold not found or not pending' });
  return res.json({ discarded: true, hold: inboundHoldView(row) });
}));

// Confirms an admin token without performing any mutation.
app.get('/api/dashboard/admin/verify', requireAdmin, (req: Request, res: Response) => {
  return res.json({ ok: true, role: 'admin' });
});

// ----------------------------------------------------
// OBSERVABILITY ENDPOINTS
// ----------------------------------------------------

app.get('/api/observability/metrics', requireAdmin, (req: Request, res: Response) => {
  return res.json(metrics.snapshot());
});

app.get('/api/observability/metrics/prometheus', requireAdmin, (req: Request, res: Response) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  return res.send(metrics.toPrometheus());
});

app.get('/api/observability/logs', requireAdmin, (req: Request, res: Response) => {
  return res.json(logger.getRecentLogs());
});

app.post('/api/dashboard/logs/clear', requireAdmin, (req: Request, res: Response) => {
  eventBus.clearHistory();
  return res.json({ success: true });
});

app.get('/api/dashboard/metrics', requireAdmin, (req: Request, res: Response) => {
  const history = eventBus.getHistory();
  const total = history.length;
  
  if (total === 0) {
    return res.json({
      totalRequests: 0,
      successRate: 0,
      averageLatency: 0,
      totalCost: 0,
      volumePerProvider: {},
      volumePerApp: {}
    });
  }

  const successCount = history.filter(h => h.status === 'success').length;
  const sumLatency = history.reduce((sum, h) => sum + h.latency, 0);
  const sumCost = history.reduce((sum, h) => sum + h.cost, 0);

  const volumePerProvider: Record<string, number> = {};
  const volumePerApp: Record<string, number> = {};

  history.forEach(h => {
    volumePerProvider[h.providerId] = (volumePerProvider[h.providerId] || 0) + 1;
    volumePerApp[h.appId] = (volumePerApp[h.appId] || 0) + 1;
  });

  return res.json({
    totalRequests: total,
    successRate: (successCount / total) * 100,
    averageLatency: sumLatency / total,
    totalCost: sumCost,
    volumePerProvider,
    volumePerApp
  });
});

app.get('/api/dashboard/stream', requireAdmin, (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  // P2-3: Filter SSE events by tenantId + appId query params
  const filterTenantId = req.query.tenantId as string | undefined;
  const filterAppId = req.query.appId as string | undefined;

  // Phase 7 (gap register C16): events now carry tenantId, and a filter is
  // a real filter — an event WITHOUT the requested tenant/app is excluded
  // (this used to short-circuit to "include" whenever the event had no
  // tenantId, which before Phase 7 was every event).
  const unsubscribe = eventBus.subscribe((event: any) => {
    if (filterTenantId && event.tenantId !== filterTenantId) return;
    if (filterAppId && event.appId !== filterAppId) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// Catches errors forwarded by asyncHandler/next(err) and records them as API
// errors. Registered LAST: Express only routes an error to error middleware
// registered after the route that raised it, so routes added below an
// earlier position of this handler (dashboard metrics/stream, etc.) used to
// fall through to Express's default HTML 500.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  metrics.increment('apiErrors');
  logger.error('unhandled error', {
    operation: `${req.method} ${req.path}`,
    errorCode: 'UNHANDLED',
    status: 'failed',
    error: err instanceof Error ? err.message : String(err),
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
