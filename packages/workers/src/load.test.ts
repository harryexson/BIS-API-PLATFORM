import { describe, it, expect } from 'vitest';
import { runLoadSuite } from './loadHarness';

function printReport(result: Awaited<ReturnType<typeof runLoadSuite>>) {
  console.log('\n=== LOAD TEST RESULTS (backend: ' + result.backend + ') ===');
  console.log(
    [
      'scenario'.padEnd(46),
      'rps'.padStart(7),
      'p50'.padStart(6),
      'p95'.padStart(6),
      'p99'.padStart(6),
      'err%'.padStart(6),
      'qDepth'.padStart(7),
      'provMs'.padStart(7),
    ].join(' '),
  );
  for (const s of result.scenarios) {
    console.log(
      [
        s.scenario.slice(0, 44).padEnd(46),
        String(s.rps).padStart(7),
        String(s.latencyMs.p50).padStart(6),
        String(s.latencyMs.p95).padStart(6),
        String(s.latencyMs.p99).padStart(6),
        (s.errorRate * 100).toFixed(1).padStart(6),
        String(s.queueDepthMax).padStart(7),
        String(s.providerLatencyAvg ?? '-').padStart(7),
      ].join(' '),
    );
    if (s.dbWriteLatencyMs !== null) {
      console.log(`   dbWriteLatencyMs=${s.dbWriteLatencyMs}  notes: ${s.notes}`);
    } else {
      console.log(`   notes: ${s.notes}`);
    }
  }
  console.log('=== END ===\n');
}

describe('load testing', () => {
  it('measures throughput and latency under increasing load', async () => {
    const result = await runLoadSuite();
    printReport(result);

    expect(result.scenarios.length).toBeGreaterThan(0);
    for (const s of result.scenarios) {
      expect(s.rps).toBeGreaterThanOrEqual(0);
      expect(s.errorRate).toBeGreaterThanOrEqual(0);
      expect(s.errorRate).toBeLessThanOrEqual(1);
    }
    const shared = result.scenarios.find((s) =>
      s.scenario.startsWith('Thousands of messages'),
    );
    expect(shared).toBeDefined();
    expect(shared!.completed).toBeGreaterThan(0);
  }, 120_000);
});
