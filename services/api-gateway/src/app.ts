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
  sendTransactionalEmail,
  verificationEmailHtml,
  passwordResetEmailHtml,
} from '@company/shared';
import {
  createStore,
  createKeys,
  createWorkerConfig,
  JobQueue,
  type KVStore,
  type Keys,
  type WorkerConfig,
} from '@company/workers';
import { signPortalToken, verifyPortalToken, PortalTokenPayload } from './jwt';

const platformIdempotency = new PlatformIdempotencyService();

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
      const authed = req as Request & { appId?: string; body?: any };
      if (authed.appId) setContextField('applicationId', authed.appId);
      const tenant = req.header('x-tenant-id') || authed.body?.tenantId;
      if (tenant) setContextField('tenantId', tenant);
      const supplier = req.header('x-supplier-id') || authed.body?.supplierId;
      if (supplier) setContextField('supplierId', supplier);

      const latency = Date.now() - start;
      const status = res.statusCode;

      const logFields: Record<string, any> = {
        method: req.method,
        path: req.path,
        status,
        latency,
        providerId: c.providerId,
        applicationId: c.applicationId,
        tenantId: c.tenantId,
      };

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
// fanned out to every active, subscribed webhook_endpoints row for that
// event's appId (TransactionEvent carries no tenantId, so dispatch can
// only key on appId — see the schema's class comment), signed with that
// endpoint's own secret. Backs the POST/GET/DELETE /v1/api/gateway/webhooks
// registration routes below.
const webhookDelivery = new WebhookDelivery();
webhookDelivery.start();

async function dispatchOutboundWebhooks(event: TransactionEvent): Promise<void> {
  if (!event.appId) return;
  let endpoints;
  try {
    endpoints = await webhookEndpointRepository.findActiveByAppId(event.appId);
  } catch {
    // No DB configured (e.g. some simulation/test contexts) — nothing to
    // dispatch to; never let this block the event that triggered it.
    return;
  }
  if (endpoints.length === 0) return;

  for (const endpoint of endpoints) {
    const eventTypes = Array.isArray(endpoint.eventTypes) ? (endpoint.eventTypes as string[]) : ['*'];
    if (!eventTypes.includes('*') && !eventTypes.includes(event.category)) continue;

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
async function resolveTenantContext(req: Request, res: Response, next: NextFunction) {
  const authed = req as Request & { appId?: string };
  if (!authed.appId) return next();

  const tenantId = req.header('x-tenant-id');
  if (!tenantId) {
    logger.warn('tenant context missing', {
      operation: 'tenant-resolution',
      errorCode: 'TENANT_REQUIRED',
      status: 'failed',
    });
    return res.status(400).json({ error: 'x-tenant-id header is required' });
  }

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
    next();
  } catch {
    logger.warn('tenant access denied', {
      operation: 'tenant-resolution',
      errorCode: 'TENANT_ACCESS_DENIED',
      status: 'failed',
    });
    return res.status(403).json({ error: 'Access denied: tenant not linked to this application' });
  }
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

app.post('/v1/api/gateway/payment', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { amount, currency, paymentMethod, providerOverride, phoneNumber } = req.body;
  const tenantId = req.header('x-tenant-id') || 'default';
  // Canonical header per docs/openapi.yaml is `Idempotency-Key`; `idempotency_key`
  // in the body is the documented fallback. (The previous `x-idempotency-key`
  // header name never matched what docs/SDK/clients actually send, so this
  // safeguard was silently inert.)
  const idempotencyKey: string | undefined = req.header('idempotency-key') || req.body.idempotency_key;

  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }

  // Fingerprint the mutating fields so a replayed key with a *different*
  // payload is rejected instead of silently returning the wrong cached charge.
  const requestFingerprint = JSON.stringify({ amount, currency, paymentMethod, providerOverride, phoneNumber });
  let idempotencyRecordId: string | undefined;

  if (idempotencyKey) {
    const claim = await platformIdempotency.checkAndClaim(appId, tenantId, 'payment', idempotencyKey);
    if (!claim.claimed) {
      if (claim.existingResult) {
        if (claim.existingResult.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({
            error: {
              code: 'idempotency_conflict',
              message: 'Idempotency-Key already used with a different payload',
              resource: claim.existingResult.event,
            },
          });
        }
        metrics.increment('paymentIdempotentHits');
        return res.json(claim.existingResult.event);
      }
      return res.status(409).json({
        error: { code: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is already being processed' },
      });
    }
    idempotencyRecordId = claim.recordId;
  }

  try {
    const event = await routingEngine.routePayment(appId, {
      amount: Number(amount),
      currency,
      paymentMethod,
      providerOverride,
      phoneNumber
    });

    // P0: Create a transaction record for state tracking.
    // The webhook processor will update the status based on provider events.
    try {
      await transactionRepository.create({
        appId,
        tenantId,
        providerId: event.providerId,
        providerTransactionId: event.id,
        status: event.status === 'success' ? 'success' : event.status === 'failed' ? 'failed' : 'pending',
        amount: String(event.amount),
        currency: event.currency || 'USD',
        paymentMethod: paymentMethod || null,
        idempotencyKey: idempotencyKey || null,
      });
    } catch (txErr) {
      // Transaction creation is best-effort — don't fail the payment if it fails
      console.error('[payment] Failed to create transaction record', txErr);
    }

    eventBus.emit(event);
    observe(event);

    if (idempotencyRecordId) {
      await platformIdempotency.complete(idempotencyRecordId, { requestFingerprint, event }).catch(() => undefined);
    }

    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
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
      error: 'Payment routing failed'
    };
    eventBus.emit(errorEvent);
    observeFailure('payment', errorEvent.providerId, 'ROUTING_FAILED');
    observe(errorEvent);
    if (idempotencyRecordId) {
      await platformIdempotency.fail(idempotencyRecordId, errorEvent.error).catch(() => undefined);
    }
    return res.status(503).json({ error: 'Payment routing failed', id: errorEvent.id });
  }
});

app.post('/v1/api/gateway/messaging', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { recipient, content, providerOverride } = req.body;
  // P0: Use authenticated tenant from header, NOT from request body
  const tenantId = req.header('x-tenant-id');

  if (!appId || !recipient || !content) {
    return res.status(400).json({ error: 'Missing required parameters: appId, recipient, and content are required' });
  }

  try {
    const event = await routingEngine.routeMessage(appId, {
      recipient,
      content,
      providerOverride,
      tenantId, // Pass authenticated tenant to routing engine
    });

    eventBus.emit(event);
    observe(event);
    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 30,
      cost: 0,
      decisionReason: 'routing_failure',
      payload: {},
      response: null,
      error: 'Message routing failed'
    };
    eventBus.emit(errorEvent);
    observeFailure('messaging', errorEvent.providerId, 'ROUTING_FAILED');
    observe(errorEvent);
    return res.status(503).json({ error: 'Message routing failed', id: errorEvent.id });
  }
});

app.post('/v1/api/gateway/other', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { serviceType, payload, providerOverride } = req.body;

  if (!appId || !serviceType) {
    return res.status(400).json({ error: 'Missing parameters: appId and serviceType are required' });
  }

  try {
    const event = await routingEngine.routeOther(appId, {
      serviceType,
      payload,
      providerOverride
    });

    eventBus.emit(event);
    observe(event);
    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
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
  const appId = (req as Request & { appId?: string }).appId;
  const events = eventBus.getHistory();

  // P0: Enforce ownership — only return events belonging to the authenticated application
  const event = events.find((e: TransactionEvent) => e.id === id && e.appId === appId);

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
app.post('/refunds', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const tenantId = req.header('x-tenant-id') || 'default';
  const { payment_id: paymentId, amount, currency, reason, metadata } = req.body;
  const idempotencyKey: string | undefined = req.header('idempotency-key') || req.body.idempotency_key;

  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }
  if (!paymentId) {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'Missing required field: payment_id' } });
  }

  const requestFingerprint = JSON.stringify({ paymentId, amount, currency, reason });
  let idempotencyRecordId: string | undefined;

  if (idempotencyKey) {
    const claim = await platformIdempotency.checkAndClaim(appId, tenantId, 'refund', idempotencyKey);
    if (!claim.claimed) {
      if (claim.existingResult) {
        if (claim.existingResult.requestFingerprint !== requestFingerprint) {
          return res.status(409).json({
            error: {
              code: 'idempotency_conflict',
              message: 'Idempotency-Key already used with a different payload',
              resource: claim.existingResult.refund,
            },
          });
        }
        return res.status(201).json(claim.existingResult.refund);
      }
      return res.status(409).json({
        error: { code: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is already being processed' },
      });
    }
    idempotencyRecordId = claim.recordId;
  }

  // Ownership: only the application that made the original payment may refund it.
  const original = eventBus
    .getHistory()
    .find((e: TransactionEvent) => e.id === paymentId && e.appId === appId && e.category === 'payment');

  if (!original) {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, 'payment not found').catch(() => undefined);
    return res.status(404).json({ error: { code: 'not_found', message: `Payment '${paymentId}' not found` } });
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
    const refundEvent = await provider.refund(
      appId,
      { originalTransactionId: paymentId, amount, currency: currency || original.currency, reason, metadata },
      'refund_requested',
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
      await platformIdempotency.complete(idempotencyRecordId, { requestFingerprint, refund }).catch(() => undefined);
    }

    return res.status(201).json(refund);
  } catch (err: any) {
    if (idempotencyRecordId) await platformIdempotency.fail(idempotencyRecordId, err.message).catch(() => undefined);
    observeFailure('payment', original.providerId, 'REFUND_FAILED');
    return res.status(503).json({ error: { code: 'refund_failed', message: 'Refund failed' } });
  }
});

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

  try {
    const event = req.body;
    const updated = await subscriptionRegistry.syncFromStripeEvent(event);
    logger.info('billing webhook processed', {
      operation: 'billing-webhook',
      status: 'success',
      applicationId: updated?.applicationId,
    });
    return res.json({ received: true });
  } catch (err: any) {
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
  const tenantId = req.header('x-tenant-id') || 'default';
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
  const tenantId = req.header('x-tenant-id') || 'default';
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
  const profiles = await messagingProfileRepository.findByApplicationId(appId);
  return res.json({ profiles, count: profiles.length });
}));

app.post('/v1/api/gateway/messaging-profiles', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const tenantId = req.header('x-tenant-id') || 'default';
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
// OUTBOUND WEBHOOK REGISTRATION (/v1/api/gateway/webhooks)
// ----------------------------------------------------
// Register a callback URL to receive a signed TransactionEvent (see
// dispatchOutboundWebhooks, above) as this application's payments/
// messages/other events happen. The signing secret is returned exactly
// once, here — it's never re-displayed, only used server-side to compute
// each delivery's X-Webhook-Signature header.
app.post('/v1/api/gateway/webhooks', mw.apiKey, resolveTenantContext, asyncHandler(async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const tenantId = req.header('x-tenant-id') || 'default';
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
  const endpoints = await webhookEndpointRepository.findByAppId(appId);
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
  const deleted = await webhookEndpointRepository.deleteScoped(req.params.id, appId);
  if (!deleted) {
    return res.status(404).json({ error: 'Webhook endpoint not found' });
  }
  return res.status(204).send();
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
app.post('/api/dashboard/playground/dispatch', requireAdmin, async (req: Request, res: Response) => {
  const { category, appId, ...fields } = req.body || {};

  if (!appId || !category) {
    return res.status(400).json({ error: 'appId and category are required' });
  }

  try {
    let event: TransactionEvent;
    if (category === 'payment') {
      const { amount, currency, paymentMethod, providerOverride, phoneNumber, paymentToken, country } = fields;
      event = await routingEngine.routePayment(appId, {
        amount: Number(amount),
        currency,
        paymentMethod,
        providerOverride,
        phoneNumber,
        paymentToken,
        country,
      });
    } else if (category === 'messaging') {
      const { recipient, content, providerOverride } = fields;
      event = await routingEngine.routeMessage(appId, { recipient, content, providerOverride });
    } else if (category === 'other') {
      const { serviceType, payload, providerOverride } = fields;
      event = await routingEngine.routeOther(appId, { serviceType, payload, providerOverride });
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
      category,
      providerId: fields.providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 30,
      cost: 0,
      decisionReason: isConsentBlock ? 'consent_blocked' : 'routing_failure',
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
  const tenantId = req.header('x-tenant-id') || 'default';
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

  const { paymentMethod, phoneNumber } = req.body;

  try {
    const event = await routingEngine.routePayment(session.appId, {
      amount: Number(session.amount),
      currency: session.currency,
      paymentMethod: paymentMethod || 'card',
      phoneNumber,
    });

    // Single-use: only the first payment attempt against this session can
    // mark it completed, so a retried/duplicated pay request can't charge twice.
    const completed = await checkoutSessionRepository.markCompleted(session.token, event.id);
    if (!completed) {
      return res.status(409).json({ error: 'Checkout session was already completed' });
    }

    try {
      await transactionRepository.create({
        appId: session.appId,
        tenantId: session.tenantId,
        providerId: event.providerId,
        providerTransactionId: event.id,
        status: event.status === 'success' ? 'success' : event.status === 'failed' ? 'failed' : 'pending',
        amount: String(event.amount),
        currency: event.currency || session.currency,
        paymentMethod: paymentMethod || null,
      });
    } catch (txErr) {
      console.error('[checkout] Failed to create transaction record', txErr);
    }

    eventBus.emit(event);
    observe(event);

    return res.json({
      status: event.status,
      id: event.id,
      successUrl: session.successUrl,
    });
  } catch (err: any) {
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

// P0-5: Inbound provider webhooks with HMAC signature verification.
// The signature is validated against WEBHOOK_HMAC_SECRET before processing.
// P0: Gateway-level webhook deduplication — reject duplicate deliveries.
const recentWebhooks = new Map<string, number>(); // eventId -> timestamp
const WEBHOOK_DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Periodically clean up expired entries
setInterval(() => {
  const cutoff = Date.now() - WEBHOOK_DEDUP_TTL_MS;
  for (const [id, ts] of recentWebhooks) {
    if (ts < cutoff) recentWebhooks.delete(id);
  }
}, 60_000);

app.post('/v1/api/webhooks/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  setContextField('providerId', provider);
  const signature = req.header('x-webhook-signature');
  const known = registry.getProvider(provider);

  if (!known) {
    metrics.increment('webhookFailures');
    logger.error('webhook rejected', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'UNKNOWN_PROVIDER',
      status: 'failed',
    });
    return res.status(401).json({ error: 'Unknown provider' });
  }

  const webhookSecret = process.env.WEBHOOK_HMAC_SECRET;
  if (!webhookSecret) {
    metrics.increment('webhookFailures');
    logger.error('webhook rejected — no secret configured', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'NO_WEBHOOK_SECRET',
      status: 'failed',
    });
    return res.status(503).json({ error: 'Webhook verification not configured' });
  }

  if (!signature) {
    metrics.increment('webhookFailures');
    logger.error('webhook rejected', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'MISSING_SIGNATURE',
      status: 'failed',
    });
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  // Timing-safe HMAC verification
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  const valid = a.length === b.length && timingSafeEqual(a, b);

  if (!valid) {
    metrics.increment('webhookFailures');
    logger.error('webhook rejected', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'INVALID_SIGNATURE',
      status: 'failed',
    });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // P0: Gateway-level deduplication — extract provider event ID and reject replays
  const providerEventId = req.body?.id;
  if (providerEventId && recentWebhooks.has(providerEventId)) {
    metrics.increment('webhookDuplicates');
    logger.warn('webhook rejected — duplicate', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'DUPLICATE_WEBHOOK',
      status: 'failed',
    });
    return res.status(409).json({ error: 'Duplicate webhook delivery' });
  }
  if (providerEventId) {
    recentWebhooks.set(providerEventId, Date.now());
  }

  logger.info('webhook received', {
    operation: 'webhook',
    providerId: provider,
    status: 'success',
  });

  // P0: Persist webhook event and emit to EventBus — previously this was a dead end
  // where the webhook was HMAC-verified then silently discarded.
  const webhookEvent = {
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
  };
  // Emit to EventBus for monitoring — persistence is handled by the paymentWebhook processor
  eventBus.emit(webhookEvent);

  // P0: Enqueue inbound message for worker routing — the worker will match
  // sender → conversation → app and route the message to the owning app.
  enqueueInboundMessage(provider, req.body).catch((err) => {
    logger.error('inbound enqueue failed', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'INBOUND_ENQUEUE_FAILED',
      status: 'failed',
    });
  });

  // P0: Enqueue payment webhook for worker processing — payment state updates,
  // receipt pipeline, and domain events are handled by the worker, not the gateway.
  enqueuePaymentWebhook({
    providerId: provider,
    rawBody: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    signature: signature || '',
    providerEventId: providerEventId || req.body?.id,
    applicationId: req.body?.data?.object?.metadata?.appId,
  }).catch((err) => {
    logger.error('payment webhook enqueue failed', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'PAYMENT_WEBHOOK_ENQUEUE_FAILED',
      status: 'failed',
    });
  });

  // P0: Also enqueue provider webhook for provider-specific processing
  // (delivery status updates, management status, etc.)
  enqueueProviderWebhook({
    providerId: provider,
    rawBody: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    signature: signature || '',
    providerEventId: providerEventId || req.body?.id,
    status: req.body?.type,
  }).catch((err) => {
    logger.error('provider webhook enqueue failed', {
      operation: 'webhook',
      providerId: provider,
      errorCode: 'PROVIDER_WEBHOOK_ENQUEUE_FAILED',
      status: 'failed',
    });
  });

  return res.json({ received: true });
});

// P0: Enqueue inbound/outbound webhooks through the platform's real,
// shared job queue (@company/workers) — the same JobQueue/KVStore
// abstraction the worker service itself uses (services/worker/src/
// index.ts), instead of a hand-rolled raw ioredis client with ad hoc key
// names that merely happened to match @company/workers's own scheme.
// createStore() degrades the same way the rest of the platform already
// does when Redis is unavailable (falls back to an ephemeral in-memory
// store, logging a warning) rather than dropping the job outright.
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

// P0: Lightweight helper to enqueue inbound messages to the worker queue.
// The worker polls from this queue and routes inbound messages to apps.
async function enqueueInboundMessage(providerId: string, payload: any): Promise<void> {
  const { queue } = await getGatewayQueue();
  await queue.enqueue('inbound_message', { providerId, payload });
}

// P0: Enqueue payment webhooks for worker processing.
// The gateway verifies HMAC and acknowledges, but payment-specific processing
// (state updates, receipt pipeline, domain events) happens in the worker.
async function enqueuePaymentWebhook(input: {
  providerId: string;
  rawBody: string;
  signature: string;
  providerEventId?: string;
  applicationId?: string;
}): Promise<void> {
  const { queue } = await getGatewayQueue();
  await queue.enqueue('payment_webhook', {
    provider: input.providerId,
    rawBody: input.rawBody,
    signature: input.signature,
    providerEventId: input.providerEventId,
    applicationId: input.applicationId || 'webhook',
  });
}

// P0: Enqueue provider webhooks (delivery status, etc.) for worker processing.
async function enqueueProviderWebhook(input: {
  providerId: string;
  rawBody: string;
  signature: string;
  providerEventId?: string;
  status?: string;
}): Promise<void> {
  const { queue } = await getGatewayQueue();
  await queue.enqueue('provider_webhook', {
    providerId: input.providerId,
    rawBody: input.rawBody,
    signature: input.signature,
    eventId: input.providerEventId,
    status: input.status,
  });
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

// Catches unhandled errors and records them as API errors.
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  metrics.increment('apiErrors');
  logger.error('unhandled error', {
    operation: `${req.method} ${req.path}`,
    errorCode: 'UNHANDLED',
    status: 'failed',
  });
  res.status(500).json({ error: 'Internal server error' });
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

  const unsubscribe = eventBus.subscribe((event: any) => {
    if (filterTenantId && event.tenantId && event.tenantId !== filterTenantId) return;
    if (filterAppId && event.appId && event.appId !== filterAppId) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

export default app;
