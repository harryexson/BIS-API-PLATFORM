import express, { Request, Response } from 'express';
import cors from 'cors';
import { ProviderRegistry } from '@company/providers';
import { RoutingEngine } from '@company/routing';
import { EventBus } from '@company/events';

const app = express();
app.use(cors());
app.use(express.json());

const registry = ProviderRegistry.getInstance();
const routingEngine = new RoutingEngine();
const eventBus = EventBus.getInstance();

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

app.post('/api/gateway/payment', async (req: Request, res: Response) => {
  const { appId, amount, currency, paymentMethod, providerOverride, phoneNumber } = req.body;
  
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
    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + Math.random().toString(36).substring(2, 12),
      timestamp: new Date().toISOString(),
      appId,
      category: 'payment' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      amount: Number(amount) || 0,
      currency: currency || 'USD',
      latency: 50,
      cost: 0,
      decisionReason: err.message,
      payload: req.body,
      response: null,
      error: err.message
    };
    eventBus.emit(errorEvent);
    return res.status(503).json(errorEvent);
  }
});

app.post('/api/gateway/messaging', async (req: Request, res: Response) => {
  const { appId, recipient, content, providerOverride } = req.body;

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
    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + Math.random().toString(36).substring(2, 12),
      timestamp: new Date().toISOString(),
      appId,
      category: 'messaging' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 30,
      cost: 0,
      decisionReason: err.message,
      payload: req.body,
      response: null,
      error: err.message
    };
    eventBus.emit(errorEvent);
    return res.status(503).json(errorEvent);
  }
});

app.post('/api/gateway/other', async (req: Request, res: Response) => {
  const { appId, serviceType, payload, providerOverride } = req.body;

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
    return res.json(event);
  } catch (err: any) {
    const errorEvent = {
      id: 'err_' + Math.random().toString(36).substring(2, 12),
      timestamp: new Date().toISOString(),
      appId,
      category: 'other' as const,
      providerId: providerOverride || 'failed_route',
      status: 'failed' as const,
      latency: 20,
      cost: 0,
      decisionReason: err.message,
      payload: req.body,
      response: null,
      error: err.message
    };
    eventBus.emit(errorEvent);
    return res.status(503).json(errorEvent);
  }
});

// ----------------------------------------------------
// DASHBOARD MANAGEMENT ENDPOINTS
// ----------------------------------------------------

app.get('/api/dashboard/providers', (req: Request, res: Response) => {
  return res.json(registry.getAllConfigs());
});

app.patch('/api/dashboard/providers/:id', (req: Request, res: Response) => {
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

app.get('/api/dashboard/logs', (req: Request, res: Response) => {
  return res.json(eventBus.getHistory());
});

app.post('/api/dashboard/logs/clear', (req: Request, res: Response) => {
  eventBus.clearHistory();
  return res.json({ success: true });
});

app.get('/api/dashboard/metrics', (req: Request, res: Response) => {
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

app.get('/api/dashboard/stream', (req: Request, res: Response) => {
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
