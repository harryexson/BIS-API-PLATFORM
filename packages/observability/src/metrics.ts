// In-memory metrics collector for the operational metrics required by the
// observability phase. Counters are monotonic; latency is kept as a bounded
// observation window so we can report percentiles without external storage.

export const METRIC_NAMES = {
  apiErrors: 'apiErrors',
  paymentSuccess: 'paymentSuccess',
  paymentFailure: 'paymentFailure',
  messageSuccess: 'messageSuccess',
  messageFailure: 'messageFailure',
  webhookFailures: 'webhookFailures',
  queueFailures: 'queueFailures',
  routingFailures: 'routingFailures',
} as const;

const PROVIDER_HEALTH_VALUE: Record<string, number> = {
  healthy: 2,
  degraded: 1,
  down: 0,
  unknown: -1,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export class Metrics {
  private counters = new Map<string, number>();
  private latencies: number[] = [];
  private providerHealth = new Map<string, string>();

  increment(name: string, amount = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + amount);
  }

  recordLatency(ms: number) {
    if (!Number.isFinite(ms)) return;
    if (this.latencies.length >= 1000) this.latencies.shift();
    this.latencies.push(ms);
  }

  setProviderHealth(providerId: string, status: string) {
    this.providerHealth.set(providerId, status);
  }

  providerHealthValue(status: string): number {
    return PROVIDER_HEALTH_VALUE[status] ?? -1;
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      counters: Object.fromEntries(this.counters),
      latency: {
        count: sorted.length,
        sum,
        avg: sorted.length ? sum / sorted.length : 0,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      },
      providerHealth: Object.fromEntries(this.providerHealth),
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`bis_${name} ${value}`);
    }
    lines.push('# TYPE bis_api_latency_ms histogram');
    const { count, sum, p50, p95, p99 } = this.snapshot().latency;
    lines.push(`bis_api_latency_ms_count ${count}`);
    lines.push(`bis_api_latency_ms_sum ${sum}`);
    lines.push(`bis_api_latency_ms{quantile="0.5"} ${p50}`);
    lines.push(`bis_api_latency_ms{quantile="0.95"} ${p95}`);
    lines.push(`bis_api_latency_ms{quantile="0.99"} ${p99}`);
    for (const [providerId, status] of this.providerHealth) {
      lines.push(`bis_provider_health{provider="${providerId}"} ${this.providerHealthValue(status)}`);
    }
    return lines.join('\n') + '\n';
  }

  reset() {
    this.counters.clear();
    this.latencies = [];
    this.providerHealth.clear();
  }
}

export const metrics = new Metrics();
