import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';
import { TransactionEvent } from '@company/schemas';
import { AuthService, createMiddleware } from './auth';
import {
  TenantRegistry,
  tenantRepository,
  tenantApplicationLinkRepository,
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
// OBSERVABILITY
// ----------------------------------------------------
// Attaches a request/correlation id to every operation and emits structured,
// redacted logs + latency/error metrics. Never logs secrets or PII — the
// logger redacts sensitive fields by default.
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  const correlationId = (req.header('x-correlation-id') as string) || requestId;
  const ctx = {
    requestId,
    correlationId,
    operation: `${req.method} ${req.path}`,
  };

  runWithContext(ctx, () => {
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
      logger.info('request completed', {
        operation: `${req.method} ${req.path}`,
        status,
        latency,
        providerId: c.providerId,
      });
      metrics.recordLatency(latency);
      if (status >= 500) metrics.increment('apiErrors');
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

app.use('/api', mw.rateLimit);

const registry = ProviderRegistry.getInstance();
const routingEngine = new RoutingEngine();
const eventBus = EventBus.getInstance();

// ----------------------------------------------------
// P0-4: TENANT ISOLATION MIDDLEWARE
// ----------------------------------------------------
// Validates that the x-tenant-id header (if provided) belongs to the
// authenticated application. Prevents cross-tenant access via IDOR.
async function resolveTenantContext(req: Request, res: Response, next: NextFunction) {
  const authed = req as Request & { appId?: string };
  if (!authed.appId) return next();

  const tenantId = req.header('x-tenant-id');
  if (!tenantId) return next();

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
    if (isProduction) {
      return res.status(503).json({ error: 'Admin access not configured' });
    }
    return next();
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

app.get('/ready', (req: Request, res: Response) => {
  res.json({
    status: 'ready',
    service: 'api-gateway',
    dependencies: {},
    timestamp: new Date().toISOString()
  });
});

// ----------------------------------------------------
// GATEWAY TRAFFIC ENDPOINTS
// ----------------------------------------------------

app.post('/api/gateway/payment', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { amount, currency, paymentMethod, providerOverride, phoneNumber } = req.body;
  
  if (!appId) {
    return res.status(400).json({ error: 'Missing parameter: appId is required' });
  }

  try {
    const event = await routingEngine.routePayment(appId, {
      amount: Number(amount),
      currency,
      paymentMethod,
      providerOverride,
      phoneNumber
    });

    eventBus.emit(event);
    observe(event);
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

app.post('/api/gateway/messaging', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
  const appId = (req as Request & { appId?: string }).appId;
  const { recipient, content, providerOverride } = req.body;

  if (!appId || !recipient || !content) {
    return res.status(400).json({ error: 'Missing required parameters: appId, recipient, and content are required' });
  }

  try {
    const event = await routingEngine.routeMessage(appId, {
      recipient,
      content,
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

app.post('/api/gateway/other', mw.apiKey, resolveTenantContext, async (req: Request, res: Response) => {
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

// P0-5: Inbound provider webhooks with HMAC signature verification.
// The signature is validated against WEBHOOK_HMAC_SECRET before processing.
app.post('/api/webhooks/:provider', async (req: Request, res: Response) => {
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

  logger.info('webhook received', {
    operation: 'webhook',
    providerId: provider,
    status: 'success',
  });
  return res.json({ received: true });
});

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

app.get('/api/dashboard/logs', (req: Request, res: Response) => {
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

  const unsubscribe = eventBus.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

export default app;
