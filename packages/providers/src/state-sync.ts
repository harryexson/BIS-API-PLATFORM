import type { ProviderRegistry, ProviderStateStore, ProviderStateSyncReport } from './registry';

/**
 * Keeps one process's ProviderRegistry converged on the persisted provider
 * state (gap register E12, Phase 15) — used identically by the API gateway
 * and the worker, so every replica of either routes by the same
 * configuration and secrets.
 *
 *  - `initialLoad` is the startup load. Callers AWAIT it before serving
 *    traffic (it never rejects; `status().loaded` says whether it worked),
 *    replacing the old fire-and-forget `void hydrateProviderSecretsFromDb()`
 *    that let early requests run on env-var/simulated credentials.
 *  - `start()` re-syncs every `intervalMs`, applying only versions newer
 *    than what this process holds — the bound on how long another replica's
 *    admin change takes to arrive here. It also retries a failed startup
 *    load. Syncs never overlap.
 */
export class ProviderStateSync {
  readonly initialLoad: Promise<void>;
  private loaded = false;
  private lastError: string | null = null;
  private lastSyncedAt: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly store: ProviderStateStore,
    private readonly opts: {
      intervalMs?: number;
      onReport?: (report: ProviderStateSyncReport) => void;
      onError?: (err: unknown) => void;
    } = {},
  ) {
    this.initialLoad = this.syncOnce();
  }

  syncOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const report = await this.registry.syncFromStore(this.store);
        this.loaded = true;
        this.lastError = null;
        this.lastSyncedAt = new Date().toISOString();
        this.opts.onReport?.(report);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.opts.onError?.(err);
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  start(): this {
    const intervalMs = this.opts.intervalMs ?? 0;
    if (intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.syncOnce(), intervalMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): {
    loaded: boolean;
    lastError: string | null;
    lastSyncedAt: string | null;
    secretFailures: Array<{ slug: string; version: number; error: string }>;
  } {
    return {
      loaded: this.loaded,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
      secretFailures: this.registry.getSecretLoadFailures(),
    };
  }
}
