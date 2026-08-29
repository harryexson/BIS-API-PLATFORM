/**
 * BIS API Platform — Load Testing Infrastructure
 *
 * Run: npx tsx packages/loadtest/src/run.ts
 *
 * Environment variables:
 *   API_URL — Base URL of the API gateway (default: http://localhost:3001)
 *   API_KEY — API key for authentication
 *   LOAD_CONCURRENCY — Number of concurrent requests (default: 10)
 *   LOAD_DURATION_MS — Test duration in milliseconds (default: 30000)
 *   LOAD_RAMP_UP_MS — Ramp-up period in milliseconds (default: 5000)
 */

interface LoadTestConfig {
  apiUrl: string;
  apiKey: string;
  concurrency: number;
  durationMs: number;
  rampUpMs: number;
}

interface RequestResult {
  status: number;
  latencyMs: number;
  error?: string;
}

interface LoadTestReport {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestsPerSecond: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  errorRate: number;
  durationMs: number;
}

function getConfig(): LoadTestConfig {
  return {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    apiKey: process.env.API_KEY || '',
    concurrency: parseInt(process.env.LOAD_CONCURRENCY || '10', 10),
    durationMs: parseInt(process.env.LOAD_DURATION_MS || '30000', 10),
    rampUpMs: parseInt(process.env.LOAD_RAMP_UP_MS || '5000', 10),
  };
}

async function makeRequest(
  config: LoadTestConfig,
  path: string,
  method: string = 'GET',
  body?: any,
): Promise<RequestResult> {
  const start = Date.now();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    return {
      status: res.status,
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      status: 0,
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

async function runLoadTest(
  config: LoadTestConfig,
  requestFn: () => Promise<RequestResult>,
): Promise<LoadTestReport> {
  const results: RequestResult[] = [];
  const startTime = Date.now();
  const endTime = startTime + config.durationMs;

  console.log(`Starting load test: ${config.concurrency} concurrent for ${config.durationMs}ms`);

  // Create worker functions
  const workers: Promise<void>[] = [];
  for (let i = 0; i < config.concurrency; i++) {
    const worker = async () => {
      // Ramp up delay
      const rampDelay = (config.rampUpMs / config.concurrency) * i;
      await new Promise((r) => setTimeout(r, rampDelay));

      while (Date.now() < endTime) {
        const result = await requestFn();
        results.push(result);
      }
    };
    workers.push(worker());
  }

  await Promise.all(workers);

  // Calculate statistics
  const latencies = results
    .filter((r) => !r.error)
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  const totalRequests = results.length;
  const successfulRequests = results.filter(
    (r) => r.status >= 200 && r.status < 400,
  ).length;
  const failedRequests = totalRequests - successfulRequests;
  const actualDuration = Date.now() - startTime;

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    requestsPerSecond: Math.round((totalRequests / actualDuration) * 1000),
    avgLatencyMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
    p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)] || 0,
    p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] || 0,
    p99LatencyMs: latencies[Math.floor(latencies.length * 0.99)] || 0,
    maxLatencyMs: latencies[latencies.length - 1] || 0,
    errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
    durationMs: actualDuration,
  };
}

function printReport(report: LoadTestReport): void {
  console.log('\n========================================');
  console.log('  LOAD TEST REPORT');
  console.log('========================================');
  console.log(`Duration:           ${report.durationMs}ms`);
  console.log(`Total requests:     ${report.totalRequests}`);
  console.log(`Successful:         ${report.successfulRequests}`);
  console.log(`Failed:             ${report.failedRequests}`);
  console.log(`Requests/sec:       ${report.requestsPerSecond}`);
  console.log(`Error rate:         ${(report.errorRate * 100).toFixed(2)}%`);
  console.log('----------------------------------------');
  console.log(`Avg latency:        ${report.avgLatencyMs}ms`);
  console.log(`P50 latency:        ${report.p50LatencyMs}ms`);
  console.log(`P95 latency:        ${report.p95LatencyMs}ms`);
  console.log(`P99 latency:        ${report.p99LatencyMs}ms`);
  console.log(`Max latency:        ${report.maxLatencyMs}ms`);
  console.log('========================================\n');

  // Pass/fail criteria
  const pass =
    report.errorRate < 0.01 &&
    report.p95LatencyMs < 5000 &&
    report.requestsPerSecond > 10;

  if (pass) {
    console.log('✅ LOAD TEST PASSED');
  } else {
    console.log('❌ LOAD TEST FAILED');
    if (report.errorRate >= 0.01) {
      console.log(`   Error rate ${(report.errorRate * 100).toFixed(2)}% exceeds 1% threshold`);
    }
    if (report.p95LatencyMs >= 5000) {
      console.log(`   P95 latency ${report.p95LatencyMs}ms exceeds 5000ms threshold`);
    }
    if (report.requestsPerSecond <= 10) {
      console.log(`   Throughput ${report.requestsPerSecond} rps below 10 rps minimum`);
    }
  }
}

// --- Test scenarios ---

async function testHealthEndpoint(config: LoadTestConfig): Promise<void> {
  console.log('\n--- Test: Health Endpoint ---');
  const report = await runLoadTest(config, () =>
    makeRequest(config, '/health'),
  );
  printReport(report);
}

async function testPaymentEndpoint(config: LoadTestConfig): Promise<void> {
  console.log('\n--- Test: Payment Endpoint ---');
  const report = await runLoadTest(config, () =>
    makeRequest(
      config,
      '/v1/api/gateway/payment',
      'POST',
      {
        amount: 10,
        currency: 'USD',
        paymentMethod: 'card',
      },
    ),
  );
  printReport(report);
}

async function testMessageEndpoint(config: LoadTestConfig): Promise<void> {
  console.log('\n--- Test: Message Endpoint ---');
  const report = await runLoadTest(config, () =>
    makeRequest(
      config,
      '/v1/api/gateway/messaging',
      'POST',
      {
        recipient: '+15551234567',
        content: 'Load test message',
      },
    ),
  );
  printReport(report);
}

async function testWebhookEndpoint(config: LoadTestConfig): Promise<void> {
  console.log('\n--- Test: Webhook Endpoint ---');
  const report = await runLoadTest(config, () =>
    makeRequest(
      config,
      '/v1/api/webhooks/test-provider',
      'POST',
      {
        id: `evt_load_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'charge.succeeded',
        data: { object: { id: 'ch_test', amount: 1000 } },
      },
    ),
  );
  printReport(report);
}

// --- Main ---

async function main(): Promise<void> {
  const config = getConfig();

  console.log('BIS API Platform — Load Test Suite');
  console.log(`Target: ${config.apiUrl}`);
  console.log(`Concurrency: ${config.concurrency}`);
  console.log(`Duration: ${config.durationMs}ms`);

  if (!config.apiKey) {
    console.warn('⚠ No API_KEY set — unauthenticated requests will fail');
  }

  try {
    await testHealthEndpoint(config);
    await testPaymentEndpoint(config);
    await testMessageEndpoint(config);
    await testWebhookEndpoint(config);

    console.log('\n✅ All load tests completed');
  } catch (err) {
    console.error('\n❌ Load test suite failed:', err);
    process.exit(1);
  }
}

main();
