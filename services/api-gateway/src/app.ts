import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';
import { TransactionEvent, TransactionStatusResponse, ProviderCapabilityMatch } from '@company/schemas';
import { AuthService, createMiddleware } from './auth';
import {
  TenantRegistry,
  tenantRepository,
  tenantApplicationLinkRepository,
  eventRepository,
  transactionRepository,
  checkDatabaseHealth,
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

// P1-3: Explicit body size limit
app.use(express.json({ limit: '100kb' }));

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
function recordTrafficResult(providerId: string | undefined, status: 'success' | 'failed', latency: number) {
  if (!providerId) return;
  registry.recordTraffic(providerId, status === 'success', latency);
}

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
    const dbOk = await checkDatabaseHealth();
    deps.database = dbOk ? 'healthy' : 'unhealthy';
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

app.use('/api/dashboard', mw.admin);

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
