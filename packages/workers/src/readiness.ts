import type { KVStore } from './store';
import { RedisStore } from './store.redis';

/**
 * Phase 19 (gap register B13/C6): shared /ready evaluation for the gateway
 * and the worker. Both endpoints used to answer "ready" no matter what their
 * dependencies were doing (the worker checked only that its poll loop was
 * running; the gateway counted an in-memory rate limiter as healthy and
 * never looked at its job queue, EventBus or secrets).
 *
 * Every dependency is probed into one of three states:
 *  - 'up'     working.
 *  - 'down'   a connection that is currently lost but that the client keeps
 *             retrying by itself (Redis reconnect, a database blip).
 *  - 'failed' a condition that does not heal on its own: a missing secret,
 *             a queue that fell back to a per-process MemoryStore at startup,
 *             provider state that is not loaded, a stopped worker loop.
 *
 * 'failed' makes the instance not ready immediately. 'down' does too if the
 * dependency has never been up since this process started (an instance that
 * has not yet connected is not ready to take traffic). A dependency that WAS
 * up and then drops is reported at once in the body (`degraded`), but only
 * turns the endpoint to 503 once it has been continuously down for the
 * grace period — so a transient Redis/DB blip that the client reconnects
 * from by itself doesn't drain every replica at once, while sustained
 * unavailability does take the instance out of rotation.
 *
 * The grace period defaults to 30s — the provider circuit breaker's default
 * cooldown, the platform's existing definition of "this is not a blip any
 * more" — and can be set with READINESS_GRACE_MS (0 = report a lost
 * connection as not ready immediately). Orchestrator probe thresholds
 * (e.g. Kubernetes failureThreshold) add to it.
 */

export type ProbeState = 'up' | 'down' | 'failed';
export interface ProbeResult {
  state: ProbeState;
  /** Reported verbatim as dependencies[name]. */
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  dependencies: Record<string, string>;
  /** Dependencies that make this instance not ready. */
  failing: string[];
  /** Dependencies currently down but still inside the grace period. */
  degraded: string[];
}

export const up = (detail: string): ProbeResult => ({ state: 'up', detail });
export const down = (detail: string): ProbeResult => ({ state: 'down', detail });
export const failed = (detail: string): ProbeResult => ({ state: 'failed', detail });

// Same value as the provider circuit breaker's default cooldown
// (packages/providers/src/registry.ts CIRCUIT_COOLDOWN_MS).
const DEFAULT_GRACE_MS = 30_000;

export function readinessGraceMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.READINESS_GRACE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_MS;
}

export class ReadinessGate {
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly everUp = new Set<string>();
  private readonly downSince = new Map<string, number>();

  constructor(opts: { graceMs?: number; now?: () => number } = {}) {
    this.graceMs = opts.graceMs ?? readinessGraceMsFromEnv();
    this.now = opts.now ?? Date.now;
  }

  evaluate(probes: Record<string, ProbeResult>): ReadinessReport {
    const now = this.now();
    const dependencies: Record<string, string> = {};
    const failing: string[] = [];
    const degraded: string[] = [];
    for (const [name, probe] of Object.entries(probes)) {
      dependencies[name] = probe.detail;
      if (probe.state === 'up') {
        this.everUp.add(name);
        this.downSince.delete(name);
        continue;
      }
      if (probe.state === 'failed' || !this.everUp.has(name)) {
        failing.push(name);
        continue;
      }
      const since = this.downSince.get(name) ?? now;
      this.downSince.set(name, since);
      if (now - since >= this.graceMs) failing.push(name);
      else degraded.push(name);
    }
    return { ready: failing.length === 0, dependencies, failing, degraded };
  }
}

// ---------------------------------------------------------------------------
// Probes shared by the gateway and the worker
// ---------------------------------------------------------------------------

/**
 * The job queue's ACTUAL backing store, not the configured one. createStore()
 * falls back to a per-process MemoryStore when Redis can't be reached at
 * startup (gap register B1/B2): jobs in it never reach another process and
 * are lost on restart, and the process never switches back — so that is a
 * hard failure, not a blip. An explicit REDIS_URL=memory (createStore's
 * single-process sentinel) is accepted outside production only.
 */
export function probeQueueStore(store: KVStore, redisUrl: string | undefined, production: boolean): ProbeResult {
  if (store instanceof RedisStore) {
    return store.isConnected() ? up('redis') : down('redis-disconnected');
  }
  const redisConfigured = Boolean(redisUrl) && redisUrl !== 'memory';
  if (redisConfigured) return failed('memory-fallback');
  return production ? failed('memory') : up('memory');
}

/**
 * checkDatabaseHealth() grades a successful query by latency: 'healthy'
 * (<200ms), 'degraded' (<1s), 'unhealthy' (slower, or the query failed).
 * A 'degraded' answer means the database IS reachable and working — e.g. a
 * neon-http round trip or a compute waking up — so it counts as up (the
 * grade is still reported). Treating it as not ready drained instances on a
 * single slow probe.
 */
export async function probeDatabase(check: () => Promise<{ status: string }>): Promise<ProbeResult> {
  try {
    const { status } = await check();
    return status === 'healthy' || status === 'degraded' ? up(status) : down(status);
  } catch {
    return down('unreachable');
  }
}

export type EventBusRedisStatus = 'not-configured' | 'connected' | 'disconnected';

/**
 * The EventBus's Redis publish connection. Not configured = single-process
 * mode (local delivery is the only delivery), which the queue probe already
 * refuses in production.
 */
export function probeEventBus(status: EventBusRedisStatus): ProbeResult {
  if (status === 'connected') return up('connected');
  if (status === 'not-configured') return up('not-configured');
  return down('disconnected');
}

/** Persisted provider configuration/secrets (Phase 15). */
export function probeProviderState(state: { loaded: boolean; secretFailures: unknown[] }): ProbeResult {
  if (!state.loaded) return failed('not-loaded');
  return state.secretFailures.length > 0 ? failed('degraded') : up('ready');
}

export function missingSecrets(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return names.filter((name) => !env[name] || env[name]!.trim() === '');
}

/**
 * Required secrets are a deployment-configuration check: in production a
 * missing one means the instance cannot do its job (webhooks rejected or
 * dead-lettered, provider secrets undecryptable, admin/portal auth broken or
 * per-process) and will never recover by itself, so it fails readiness —
 * which also stops a misconfigured rollout from ever receiving traffic.
 * Outside production the code runs without them on purpose (dev fallbacks),
 * so they are only reported.
 */
export function probeSecrets(missing: string[], production: boolean): ProbeResult {
  if (missing.length === 0) return up('configured');
  return production ? failed('missing') : up('missing-non-production');
}
