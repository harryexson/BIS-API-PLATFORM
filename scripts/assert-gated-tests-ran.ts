/**
 * Phase 23-24 (CI/CD gating): fail the CI job if any test that needs a real
 * backing service was SKIPPED instead of run.
 *
 *   npx tsx scripts/assert-gated-tests-ran.ts <vitest-json-report> <postgres|redis> [<postgres|redis> ...]
 *
 * Every real-Postgres suite (`*.postgres.integration.test.ts`) skips itself
 * when TEST_POSTGRES_URL is unset, and every real-Redis suite skips itself
 * when no redis-server binary (or TEST_REDIS_URL) is available
 * (packages/workers/src/test-utils/redis-server.ts → `redisAvailable`). That
 * is right for a developer laptop, but it meant CI reported green while
 * never executing any of them: TEST_POSTGRES_URL was never set in
 * .github/workflows/ci.yml, so all 18 Postgres suites (208 tests) were
 * skipped on every run. A skip is silent — this makes it loud.
 *
 * Gates:
 *   postgres  every test in a `*.postgres.integration.test.ts` file;
 *   redis     every test in a non-`*.integration.test.ts` test file whose
 *             source uses `redisAvailable` (the integration ones that also
 *             need Redis are covered by the postgres gate, in the job that
 *             provides both).
 * A gate also fails when it matches NO test file at all (a renamed variable,
 * a moved directory, or a wrong vitest config must not turn into a vacuous
 * pass).
 */
import { readFileSync } from 'node:fs';

interface AssertionResult {
  fullName: string;
  status: string;
}
interface FileResult {
  name: string;
  assertionResults: AssertionResult[];
}

const GATES = {
  postgres: (file: string) => file.endsWith('.postgres.integration.test.ts'),
  redis: (file: string) => {
    if (file.endsWith('.integration.test.ts')) return false;
    try {
      return /\bredisAvailable\b/.test(readFileSync(file, 'utf8'));
    } catch {
      return false;
    }
  },
} as const;
type Gate = keyof typeof GATES;

const [reportPath, ...gateArgs] = process.argv.slice(2);
if (!reportPath || gateArgs.length === 0 || gateArgs.some((g) => !(g in GATES))) {
  process.stderr.write(`usage: assert-gated-tests-ran.ts <vitest-json-report> <${Object.keys(GATES).join('|')}>...\n`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { testResults: FileResult[] };
const rel = (f: string) => f.replace(`${process.cwd()}/`, '');
let failed = false;

for (const gate of gateArgs as Gate[]) {
  const files = report.testResults.filter((r) => GATES[gate](r.name));
  let ran = 0;
  const notRun: string[] = [];
  for (const f of files) {
    for (const a of f.assertionResults) {
      if (a.status === 'passed' || a.status === 'failed') ran++;
      else notRun.push(`  ${rel(f.name)} — [${a.status}] ${a.fullName}`);
    }
  }
  process.stdout.write(`${gate} gate: ${files.length} file(s), ${ran} test(s) executed, ${notRun.length} not executed\n`);
  if (files.length === 0) {
    process.stdout.write(`::error::${gate} gate matched no test files — the gated suites did not run at all\n`);
    failed = true;
  }
  if (notRun.length > 0) {
    process.stdout.write(`::error::${notRun.length} ${gate}-gated test(s) were skipped instead of run:\n${notRun.join('\n')}\n`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
