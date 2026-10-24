/**
 * Phase 23-24 (CI/CD gating): boot a service with its REAL production start
 * command and probe it over HTTP — the check whose absence let
 * `"build": "tsc --noEmit"` + `"start": "node dist/index.js"` (a start script
 * pointing at a file no script ever produced) pass every CI run and then crash
 * the live Railway deployment with MODULE_NOT_FOUND on every boot.
 *
 *   npx tsx scripts/service-boot-smoke.ts <api-gateway|worker>
 *
 * Runs `npm run start -w services/<service>` from the repository root — the
 * exact command the Railway service runs — with the caller's environment, then:
 *   1. waits for GET /health to answer 200 with the right `service` name (the
 *      process must not exit first);
 *   2. GET /ready must answer 200 or 503 with a well-formed readiness body,
 *      and — when SMOKE_ALLOW_FAILING is set (comma list) — every dependency
 *      in `failing` must be in that list (CI has no Neon endpoint for the
 *      neon-http driver, so `database`/`providers` are expected; everything
 *      else, e.g. a real Redis, must be up);
 *   3. sends SIGTERM to the npm process only (what the platform signals) and
 *      requires a clean exit (code 0) within SMOKE_SHUTDOWN_TIMEOUT_MS.
 * Exit code 0 = all checks passed; 1 = a check failed (the service's last
 * output is printed).
 *
 * Port: the service's own variable (PORT for api-gateway, WORKER_HEALTH_PORT
 * for worker) must be set by the caller.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SERVICES = {
  'api-gateway': { portVar: 'PORT', serviceName: 'api-gateway' },
  worker: { portVar: 'WORKER_HEALTH_PORT', serviceName: 'worker' },
} as const;
type ServiceId = keyof typeof SERVICES;

const REPO_ROOT = path.resolve(__dirname, '..');

const log = (msg: string) => process.stderr.write(`[boot-smoke] ${msg}\n`);

function fail(msg: string, output?: string): never {
  log(`FAIL: ${msg}`);
  if (output) process.stderr.write(`----- last service output -----\n${output.slice(-6000)}\n-------------------------------\n`);
  process.exit(1);
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function main(): Promise<void> {
  const id = process.argv[2] as ServiceId;
  if (!(id in SERVICES)) fail(`usage: service-boot-smoke.ts <${Object.keys(SERVICES).join('|')}>`);
  const { portVar, serviceName } = SERVICES[id];
  const port = process.env[portVar];
  if (!port || !/^\d+$/.test(port)) fail(`${portVar} must be set to the port the service should listen on`);

  const bootTimeoutMs = Number(process.env.SMOKE_BOOT_TIMEOUT_MS) || 60_000;
  const shutdownTimeoutMs = Number(process.env.SMOKE_SHUTDOWN_TIMEOUT_MS) || 45_000;
  const allowFailing = process.env.SMOKE_ALLOW_FAILING?.split(',').map((s) => s.trim()).filter(Boolean);

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'services', id, 'package.json'), 'utf8'));
  log(`${id}: start script = ${JSON.stringify(pkg.scripts?.start)} (NODE_ENV=${process.env.NODE_ENV ?? '<unset>'})`);

  const started = Date.now();
  const child = spawn('npm', ['run', 'start', '-w', `services/${id}`], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so a failed run can be cleaned up completely; the
    // graceful-shutdown check below still signals ONLY the npm process.
    detached: true,
  });
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const proc: { exited: boolean; code: number | null; signal: NodeJS.Signals | null } = { exited: false, code: null, signal: null };
  const exited = new Promise<void>((resolve) =>
    child.once('exit', (code, signal) => {
      Object.assign(proc, { exited: true, code, signal });
      resolve();
    }),
  );
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  process.on('exit', killGroup);

  const base = `http://127.0.0.1:${port}`;

  // 1. liveness
  let health: { status: number; body: unknown } | undefined;
  for (;;) {
    if (proc.exited) {
      fail(`${id} exited before answering /health (code ${proc.code}, signal ${proc.signal})`, output);
    }
    try {
      health = await getJson(`${base}/health`);
      if (health.status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - started > bootTimeoutMs) fail(`${id} did not answer /health 200 within ${bootTimeoutMs}ms`, output);
    await new Promise((r) => setTimeout(r, 250));
  }
  const hb = health.body as { service?: unknown };
  if (hb?.service !== serviceName) fail(`/health body names service ${JSON.stringify(hb?.service)}, expected "${serviceName}"`, output);
  log(`${id}: /health 200 after ${Date.now() - started}ms — ${JSON.stringify(health.body)}`);

  // 2. readiness — well-formed, and failing only where the environment says it may
  const ready = await getJson(`${base}/ready`).catch((err) => fail(`/ready request failed: ${err}`, output));
  const rb = ready.body as { service?: unknown; status?: unknown; dependencies?: unknown; failing?: unknown };
  if (ready.status !== 200 && ready.status !== 503) fail(`/ready answered HTTP ${ready.status}`, output);
  if (rb?.service !== serviceName || typeof rb.status !== 'string' || typeof rb.dependencies !== 'object' || !Array.isArray(rb.failing)) {
    fail(`/ready body is not a readiness report: ${JSON.stringify(ready.body)}`, output);
  }
  log(`${id}: /ready ${ready.status} — ${JSON.stringify(ready.body)}`);
  if (allowFailing) {
    const unexpected = (rb.failing as string[]).filter((d) => !allowFailing.includes(d));
    if (unexpected.length > 0) {
      fail(`/ready reports unexpected failing dependencies [${unexpected.join(', ')}] (allowed: [${allowFailing.join(', ')}])`, output);
    }
  }

  // 3. graceful shutdown on SIGTERM to the npm process (what the platform signals)
  const sigtermAt = Date.now();
  process.kill(child.pid!, 'SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), shutdownTimeoutMs).unref()),
  ]);
  if (timedOut) fail(`${id} did not exit within ${shutdownTimeoutMs}ms of SIGTERM`, output);
  if (proc.code !== 0) fail(`${id} exited with code ${proc.code} (signal ${proc.signal}) after SIGTERM, expected 0`, output);
  log(`${id}: exited 0 ${Date.now() - sigtermAt}ms after SIGTERM`);
  log(`PASS: ${id} booted with its production start command, answered /health and /ready, and shut down cleanly`);
  process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
