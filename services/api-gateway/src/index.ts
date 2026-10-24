import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import type { Server } from 'node:http';
import app, { providerStateReady, providerStateStatus } from './app';
import { logger, metrics } from '@company/observability';

const PORT = process.env.PORT || 3001;

let server: Server | undefined;

// Phase 15 (gap register E12): do not accept a single request until the
// persisted provider configuration and secrets have been loaded (the load
// itself never rejects — on failure /ready and, in production, /v1 answer
// 503 until a background re-sync succeeds; see app.ts).
providerStateReady.then(() => {
  const state = providerStateStatus();
  if (!state.loaded) {
    logger.error('persisted provider state NOT loaded at startup — retrying in the background', {
      operation: 'startup',
      errorCode: 'PROVIDER_STATE_LOAD_FAILED',
      status: 'degraded',
      error: state.lastError,
    });
  }
  server = app.listen(PORT, () => {
    logger.info('BIS-API-PLATFORM gateway running', {
      operation: 'startup',
      status: 'running',
      port: Number(PORT),
      sseStreamUrl: `http://localhost:${PORT}/api/dashboard/stream`,
    });
  });
});

// P3-3: Graceful shutdown — drain in-flight requests before closing
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('gateway shutting down', { operation: 'shutdown', status: 'draining' });

  // Stop accepting new connections
  if (!server) process.exit(0);
  server.close(() => {
    logger.info('gateway stopped', { operation: 'shutdown', status: 'stopped' });
    process.exit(0);
  });

  // Force kill after 30s
  setTimeout(() => {
    logger.error('gateway forced shutdown after timeout', {
      operation: 'shutdown',
      errorCode: 'SHUTDOWN_TIMEOUT',
      status: 'failed',
    });
    process.exit(1);
  }, 30_000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Last-resort safety net — NOT the fix. Route handlers that can reject are
// wrapped in asyncHandler (app.ts), which turns their errors into HTTP
// responses; this only catches a rejection that still slips through
// (a fire-and-forget promise somewhere, a future handler someone forgets to
// wrap).
//
// Why log-and-stay-up instead of Node's default crash for REJECTIONS:
// - The gateway is shared by every application and tenant. One client's
//   poison request (e.g. the idempotency-key reuse that used to throw 23505
//   here) must not drop every other tenant's in-flight payments.
// - Crash-and-restart turns that one request into a repeatable DoS, and
//   aborts in-flight requests on all other connections mid-charge, which is
//   worse for payment consistency than leaving one request unanswered (the
//   504 request-timeout middleware still answers it).
// - A rejected promise does not leave the synchronous call stack half-run
//   the way an uncaught exception can, so continuing is reasonable.
// Trade-off: a bug can stay hidden — so every occurrence is logged at error
// level and counted (metric `unhandledRejections`) and must be alerted on.
//
// `uncaughtException` is deliberately NOT handled: after a synchronous throw
// escapes, process state may be inconsistent, so crashing (and letting the
// supervisor restart the process) is the safer behaviour there.
process.on('unhandledRejection', (reason) => {
  metrics.increment('unhandledRejections');
  logger.error('unhandled promise rejection (process kept alive)', {
    operation: 'process',
    errorCode: 'UNHANDLED_REJECTION',
    status: 'failed',
    error: reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason),
  });
});
