import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine, ConsentBlockedError } from '@company/routing';
import { EventBus } from '@company/events';
import { TransactionEvent, TransactionStatusResponse, TransactionStatus, ProviderCapabilityMatch } from '@company/schemas';
import { AuthService, createMiddleware } from './auth';
import {
  TenantRegistry,
  tenantRepository,
  tenantApplicationLinkRepository,
  eventRepository,
  transactionRepository,
  checkDatabaseHealth,
  consentRecordRepository,
  messagingProfileRepository,
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
  AuthRegistry,
  AuthError,
  ValidationError,
  ConflictError,
  userRepository,
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
} from '@company/database';
import {
  logger,
  metrics,
  runWithContext,
  getContext,
  setContextField,
} from '@company/observability';

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

  // 'unknown' (an ambiguous provider timeout — see RoutingEngine.routePayment)
  // is neither a success nor a confirmed failure. Counting it as either
  // would misrepresent provider reliability and paper over outcomes that
  // still need reconciliation.
  if (event.category === 'payment') {
    metrics.increment(
      event.status === 'success' ? 'paymentSuccess' : event.status === 'unknown' ? 'paymentUnknown' : 'paymentFailure',
    );
  } else if (event.category === 'messaging') {
    metrics.increment(
      event.status === 'success' ? 'messageSuccess' : event.status === 'unknown' ? 'messageUnknown' : 'messageFailure',
    );
  }

  logger.info('gateway operation completed', {
    operation: event.category,
    providerId: event.providerId,
    status: event.status,
    latency: event.latency,
    errorCode: event.status === 'success' ? undefined : event.status === 'unknown' ? 'OPERATION_AMBIGUOUS' : 'OPERATION_FAILED',
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
  adminKey: process.env.PLATFORM_ADMIN_KEY,
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
    const tenantRegistry = new TenantRegistry(tenantRepository, tenantApplicationLinkRepository);
    await tenantRegistry.assertTenantAccess(authed.appId, tenantId);
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
  const token = req.header('x-admin-token');
  if (!ADMIN_API_TOKEN) {
    // P0: Never bypass admin auth — require token in ALL environments
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  if (!token || token !== ADMIN_API_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: administrator authorization required' });
  }
  return next();
}

// Records live traffic outcomes against the provider management stats.
function recordTrafficResult(providerId: string | undefined, status: TransactionStatus, latency: number) {
  if (!providerId) return;
  // An ambiguous ('unknown') outcome doesn't tell us anything about the
  // provider's actual reliability — recording it as either a success or a
  // failure would skew their measured error rate over something that may
  // not even be their fault (a network blip between us and them).
  if (status === 'unknown') return;
  registry.recordTraffic(providerId, status === 'success', latency);
}

// ----------------------------------------------------
// CUSTOMER ACCOUNT AUTH
// ----------------------------------------------------
// Signup/login for the developers/businesses that own a BIS Platform
// application (e.g. "Reach Church") — distinct from the per-application
// API-key auth (mw.apiKey, above) used on /v1/api/gateway/* and the
// single shared-secret admin auth (requireAdmin) used on /api/dashboard/*.
// Session tokens are opaque and revocable, not stateless JWTs — see
// AuthRegistry's docstring in packages/database/src/auth-registry.ts.
// Rate-limited by the existing `app.use('/v1/api', mw.rateLimit)` above
// (keyed by IP, since these routes carry no API key).
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

app.post('/v1/api/auth/signup', async (req: Request, res: Response) => {
  const { email, password, name, applicationName, applicationSlug } = req.body || {};
  try {
    const result = await authRegistry.signup({ email, password, name, applicationName, applicationSlug });
    logger.info('account signup', {
      operation: 'auth-signup',
      applicationId: result.application.id,
      status: 'success',
    });
    return res.status(201).json({
      user: result.user,
      application: result.application,
      apiKey: result.apiKey,
      // A real transactional email send isn't built in this pass (see
      // docs/IMPLEMENTATION_BASELINE.md) — the token is only surfaced here
      // outside production so signup/verification stays testable end to
      // end today, rather than fabricating an email that was never sent.
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

app.post('/v1/api/auth/logout', requireSession, async (req: Request, res: Response) => {
  const header = req.headers['authorization'] as string;
  await authRegistry.logout(header.slice(7));
  return res.status(204).send();
});

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

app.post('/v1/api/auth/resend-verification', requireSession, async (req: Request, res: Response) => {
  const user = (req as SessionAuthedRequest).user!;
  const { token } = await authRegistry.resendEmailVerification(user.id);
  return res.json({
    message: 'Verification email requested',
    ...(process.env.NODE_ENV !== 'production' ? { emailVerificationToken: token } : {}),
  });
});

app.post('/v1/api/auth/request-password-reset', async (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  const result = await authRegistry.requestPasswordReset(email);
  // Always a generic success — never reveal whether the account exists.
  return res.json({
    message: 'If an account exists for this email, a password reset link has been sent.',
    ...(process.env.NODE_ENV !== 'production' && result ? { passwordResetToken: result.token } : {}),
  });
});

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
// SUBSCRIPTIONS / BILLING
// ----------------------------------------------------
// Billing for the platform's own customers (the businesses that hold an
// application) — distinct from packages/providers/payments, which routes
// one-off payments those businesses make on their own behalf. Plan
// management is session-authed (requireSession, above); the webhook
// route is signature-verified instead, since Stripe calls it directly.
const subscriptionRegistry = new SubscriptionRegistry(planRepository, subscriptionRepository, applicationRepository);

app.get('/v1/api/billing/plans', async (_req: Request, res: Response) => {
  const plans = await subscriptionRegistry.listPlans();
  return res.json({ plans });
});

app.get('/v1/api/billing/subscription', requireSession, async (req: Request, res: Response) => {
  const user = (req as SessionAuthedRequest).user!;
  const subscription = await subscriptionRegistry.getSubscription(user.applicationId);
  return res.json({ subscription: subscription ?? null });
});

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

// Real Stripe webhook signature verification (Stripe-Signature header:
// t=<unix seconds>,v1=<hex hmac-sha256(`${t}.${rawBody}`, secret)>) — NOT
// the generic WEBHOOK_HMAC_SECRET scheme used by /v1/api/webhooks/:provider
// above, which only ever compares against this platform's own signing
// convention and would reject every genuine Stripe delivery. Verified via
// web search against Stripe's current docs (2026-09-09), not memory.
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
// DEVELOPER CRM / SUPPORT BACK OFFICE
// ----------------------------------------------------
// BIS staff-facing (requireAdmin-gated, same single shared-secret admin
// auth used by every other /api/dashboard/* route below) — a "customer"
// here is an `application`. Confirmed absent entirely by a 2026-09-09
// audit: no endpoint anywhere listed applications for admin use before
// this section.
const crmRegistry = new CrmRegistry(
  applicationRepository,
  subscriptionRepository,
  planRepository,
  userRepository,
  customerNoteRepository,
  supportTicketRepository,
  ticketCommentRepository,
);

app.get('/api/dashboard/customers', requireAdmin, async (_req: Request, res: Response) => {
  const customers = await crmRegistry.listCustomers();
  return res.json({ customers });
});

app.get('/api/dashboard/customers/:id', requireAdmin, async (req: Request, res: Response) => {
  const customer = await crmRegistry.getCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  return res.json(customer);
});

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

app.get('/api/dashboard/tickets/:id', requireAdmin, async (req: Request, res: Response) => {
  const result = await crmRegistry.getTicket(req.params.id);
  if (!result) return res.status(404).json({ error: 'Ticket not found' });
  return res.json(result);
});

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

  // P2-5: Check database connectivity.
  // checkDatabaseHealth() resolves to a status object even for a slow or
  // degraded connection — only a hard failure (e.g. connection refused)
  // throws. Read its .status field rather than treating any resolved
  // value as healthy, or a degraded/unhealthy DB never surfaces here.
  try {
    const dbHealth = await checkDatabaseHealth();
    deps.database = dbHealth.status;
  } catch {
    deps.database = 'unreachable';
  }

  // P2-4: Report rate limiter backend
  const rlInfo = auth.getRateLimiterInfo();
  deps.rateLimiter = rlInfo.storeBacked ? 'redis' : 'in-memory';

  // Queue/worker-store backend: when REDIS_URL isn't configured, inbound
  // webhooks fall back to DB-only persistence (no async worker hand-off) —
  // that's a real degraded mode, but a separate, intentional one from a
  // configured Redis actually being unreachable. Only the latter should
  // fail readiness.
  if (process.env.REDIS_URL) {
    try {
      const client = getRedisClient();
      if (!client) throw new Error('redis client unavailable');
      await Promise.race([
        client.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 2000)),
      ]);
      deps.queue = 'healthy';
    } catch {
      deps.queue = 'unreachable';
    }
  } else {
    deps.queue = 'unconfigured';
  }

  // Provider registry is in-memory — always "ready" if process is up
  deps.providers = 'ready';

  // 'degraded' (e.g. a slow-but-connected DB) doesn't fail readiness — the
  // dependency is still serving, just worth surfacing to operators. Only
  // 'unhealthy'/'unreachable' fail it.
  const allHealthy = Object.values(deps).every(
    (v) => v === 'healthy' || v === 'ready' || v === 'in-memory' || v === 'redis' || v === 'unconfigured' || v === 'degraded',
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

app.post('/v1/api/gateway/payment', mw.apiKey('payments:send'), resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { amount, currency, paymentMethod, providerOverride, phoneNumber } = req.body;
  // P1: Accept idempotency key from header — prevents duplicate charges on retries
  const idempotencyKey = req.header('x-idempotency-key');
  
  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }

  // P1: Idempotency check — if we've seen this key recently, return the cached result
  if (idempotencyKey) {
    const existing = paymentIdempotencyCache.get(idempotencyKey);
    if (existing) {
      metrics.increment('paymentIdempotentHits');
      return res.json(existing);
    }
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
        tenantId: req.header('x-tenant-id') || 'default',
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

    // P1: Cache the result for idempotency (5 minute TTL)
    if (idempotencyKey) {
      paymentIdempotencyCache.set(idempotencyKey, event);
    }

    // 202: outcome is genuinely unresolved (provider timeout) — distinct
    // from 200 (resolved, success or failed) so a client can't mistake an
    // ambiguous result for a definite one just by checking the status code.
    // The client must poll GET /transaction/:id or wait for the provider's
    // webhook to find out what actually happened; retrying this request is
    // not automatically safe unless it does so with the same idempotency key.
    return res.status(event.status === 'unknown' ? 202 : 200).json(event);
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
    return res.status(503).json({ error: 'Payment routing failed', id: errorEvent.id });
  }
});

app.post('/v1/api/gateway/messaging', mw.apiKey('messaging:send'), resolveTenantContext, async (req: Request, res: Response) => {
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
    // Consent block is not a transient/retryable failure — surface it
    // distinctly (403) rather than the generic 503 routing failure, so
    // callers don't retry a send that will never succeed.
    const isConsentBlock = err instanceof ConsentBlockedError;
    const errorEvent = {
      id: 'err_' + randomUUID(),
      timestamp: new Date().toISOString(),
      appId,
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

app.post('/v1/api/gateway/other', mw.apiKey('other:send'), resolveTenantContext, async (req: Request, res: Response) => {
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

app.get('/v1/api/gateway/transaction/:id', mw.apiKey('transactions:read'), resolveTenantContext, (req: Request, res: Response) => {
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

// ----------------------------------------------------
// PROVIDER CAPABILITY QUERY API
// ----------------------------------------------------
// Consuming applications can discover available providers and their capabilities.

app.get('/v1/api/gateway/providers', mw.apiKey('providers:read'), resolveTenantContext, (req: Request, res: Response) => {
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

// Master plan Phase 39/section 66: consent management. STOP/JOIN keyword
// handling already writes these records (packages/routing/src/keywords.ts);
// these routes let an application query current status and set it directly
// (e.g. importing an existing suppression list) without a keyword round-trip.
app.get('/v1/api/consent/:recipient', mw.apiKey('consent:read'), resolveTenantContext, async (req: Request, res: Response) => {
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
});

app.post('/v1/api/consent', mw.apiKey('consent:write'), resolveTenantContext, async (req: Request, res: Response) => {
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
});

// Master plan Phase 40/41 (A2P/10DLC compliance model). An application
// registers the senders it uses per country/provider; complianceStatus
// tracks real-world registration state (e.g. US 10DLC campaign approval).
// Scope of this pass: the registration record and its CRUD surface — NOT
// enforcement (outbound sends are not blocked on complianceStatus here)
// and NOT integration with a real carrier/registrar API. See
// docs/IMPLEMENTATION_BASELINE.md for what's intentionally not done yet.
app.get('/v1/api/gateway/messaging-profiles', mw.apiKey('messaging-profiles:read'), resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  if (!appId) {
    return res.status(400).json({ error: 'Missing authenticated appId' });
  }
  const profiles = await messagingProfileRepository.findByApplicationId(appId);
  return res.json({ profiles, count: profiles.length });
});

app.post('/v1/api/gateway/messaging-profiles', mw.apiKey('messaging-profiles:write'), resolveTenantContext, async (req: Request, res: Response) => {
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
  const { complianceStatus } = req.body;
  if (!complianceStatus) {
    return res.status(400).json({ error: 'complianceStatus is required' });
  }
  try {
    const updated = await messagingProfileRepository.updateComplianceStatus(req.params.id, complianceStatus);
    if (!updated) {
      return res.status(404).json({ error: 'Messaging profile not found' });
    }
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to update messaging profile' });
  }
});

// P1: Payment idempotency cache — prevents duplicate charges on retry.
// Maps idempotencyKey → TransactionEvent result (5 min TTL).
const paymentIdempotencyCache = new Map<string, any>();
const PAYMENT_IDEMPOTENCY_TTL_MS = 5 * 60_000;

setInterval(() => {
  const cutoff = Date.now() - PAYMENT_IDEMPOTENCY_TTL_MS;
  for (const [key, event] of paymentIdempotencyCache) {
    const eventTime = new Date(event.timestamp).getTime();
    if (eventTime < cutoff) paymentIdempotencyCache.delete(key);
  }
}, 60_000);

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

// P0: Lightweight helper to enqueue inbound messages to the worker queue.
// Uses Redis directly if available; falls back to no-op if Redis is down.
// The worker polls from this queue and routes inbound messages to apps.
let _redisClient: any = null;
function getRedisClient(): any {
  if (_redisClient !== null) return _redisClient === false ? null : _redisClient;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) { _redisClient = false; return null; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Redis = require('ioredis');
    _redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    return _redisClient;
  } catch {
    _redisClient = false;
    return null;
  }
}

async function enqueueInboundMessage(providerId: string, payload: any): Promise<void> {
  const client = getRedisClient();
  if (!client) return; // No Redis — inbound message persisted to DB only

  const queuePrefix = process.env.WORKER_QUEUE_PREFIX || 'bis';
  const jobId = `job_${randomUUID()}`;
  const job = {
    id: jobId,
    type: 'inbound_message',
    payload: { providerId, payload },
    attempts: 0,
    maxAttempts: 5,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runAt: Date.now(),
  };

  try {
    await client.set(`${queuePrefix}:job:${jobId}`, JSON.stringify(job), 'EX', 86400);
    await client.rpush(`${queuePrefix}:ready:inbound_message`, jobId);
    await client.publish(`${queuePrefix}:notify:inbound_message`, jobId);
  } catch (err) {
    console.error('[webhook] Failed to enqueue inbound_message to Redis', err);
  }
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
  const client = getRedisClient();
  if (!client) return;

  const queuePrefix = process.env.WORKER_QUEUE_PREFIX || 'bis';
  const jobId = `job_${randomUUID()}`;
  const job = {
    id: jobId,
    type: 'payment_webhook',
    payload: {
      provider: input.providerId,
      rawBody: input.rawBody,
      signature: input.signature,
      providerEventId: input.providerEventId,
      applicationId: input.applicationId || 'webhook',
    },
    attempts: 0,
    maxAttempts: 5,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runAt: Date.now(),
  };

  try {
    await client.set(`${queuePrefix}:job:${jobId}`, JSON.stringify(job), 'EX', 86400);
    await client.rpush(`${queuePrefix}:ready:payment_webhook`, jobId);
    await client.publish(`${queuePrefix}:notify:payment_webhook`, jobId);
  } catch (err) {
    console.error('[webhook] Failed to enqueue payment_webhook to Redis', err);
  }
}

// P0: Enqueue provider webhooks (delivery status, etc.) for worker processing.
async function enqueueProviderWebhook(input: {
  providerId: string;
  rawBody: string;
  signature: string;
  providerEventId?: string;
  status?: string;
}): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  const queuePrefix = process.env.WORKER_QUEUE_PREFIX || 'bis';
  const jobId = `job_${randomUUID()}`;
  const job = {
    id: jobId,
    type: 'provider_webhook',
    payload: {
      providerId: input.providerId,
      rawBody: input.rawBody,
      signature: input.signature,
      eventId: input.providerEventId,
      status: input.status,
    },
    attempts: 0,
    maxAttempts: 5,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runAt: Date.now(),
  };

  try {
    await client.set(`${queuePrefix}:job:${jobId}`, JSON.stringify(job), 'EX', 86400);
    await client.rpush(`${queuePrefix}:ready:provider_webhook`, jobId);
    await client.publish(`${queuePrefix}:notify:provider_webhook`, jobId);
  } catch (err) {
    console.error('[webhook] Failed to enqueue provider_webhook to Redis', err);
  }
}

// ----------------------------------------------------
// DASHBOARD MANAGEMENT ENDPOINTS
// ----------------------------------------------------

// P0: was `mw.admin`, which checks `x-admin-key`/`Authorization` against
// PLATFORM_ADMIN_KEY — a *different* header and env var than the one every
// dashboard route (via requireAdmin below) and the entire admin-console
// frontend actually use (`x-admin-token` / ADMIN_API_TOKEN). Because this
// blanket check ran first and always failed against the frontend's header,
// no request from the admin console could ever authenticate against any
// /api/dashboard/* route — including every route added in this session's
// own auth/billing/CRM work, which already (correctly) used requireAdmin
// per-route but never got reached. Found via a parallel session working
// the same repo that verified this live in a browser; confirmed here by
// direct code inspection before applying. requireAdmin is the credential
// the UI is actually built against; standardizing on it here is what
// makes every /api/dashboard/* route reachable at all.
app.use('/api/dashboard', requireAdmin);

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
  const { label, value } = req.body || {};
  if (!label || !value) {
    return res.status(400).json({ error: 'Missing parameters: label and value are required' });
  }
  const meta = registry.addSecret(req.params.id, { label, value });
  if (!meta) {
    return res.status(404).json({ error: `Provider '${req.params.id}' not found` });
  }
  return res.status(201).json(meta);
});

app.delete('/api/dashboard/providers/:id/secrets/:secretId', requireAdmin, (req: Request, res: Response) => {
  const removed = registry.deleteSecret(req.params.id, req.params.secretId);
  if (!removed) {
    return res.status(404).json({ error: `Secret '${req.params.secretId}' not found for provider '${req.params.id}'` });
  }
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
