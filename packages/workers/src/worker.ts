import { KVStore } from './store';
import { Keys } from './keys';
import { Job, JobType, JobProcessor, WorkerConfig, WorkerContext } from './types';
import { JobQueue } from './queue';
import { IdempotencyStore } from './idempotency';

export class WorkerManager {
  private processors = new Map<JobType, JobProcessor>();
  private queue: JobQueue;
  private idempotency: IdempotencyStore;
  private running = false;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private sweepTimer?: ReturnType<typeof setInterval>;
  private ownerPrefix = `worker_${Math.random().toString(36).slice(2, 8)}`;
  private _inFlight = 0;

  constructor(
    private store: KVStore,
    private keys: Keys,
    private config: WorkerConfig,
  ) {
    this.queue = new JobQueue(store, keys, config);
    this.idempotency = new IdempotencyStore(store, keys, config.idempotencyTtlMs);
  }

  register(type: JobType, processor: JobProcessor): this {
    this.processors.set(type, processor);
    return this;
  }

  getQueue(): JobQueue {
    return this.queue;
  }

  getIdempotency(): IdempotencyStore {
    return this.idempotency;
  }

  isRunning(): boolean {
    return this.running;
  }

  getInFlight(): number {
    return this._inFlight;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loops = [];

    // P0: Rescue orphaned processing jobs from crashed workers on startup
    const staleThresholdMs = 2 * 60_000; // 2 minutes
    try {
      const rescued = await this.queue.rescueStuckJobs(staleThresholdMs);
      if (rescued > 0) {
        console.log(`[worker] rescued ${rescued} orphaned processing job(s) on startup`);
      }
    } catch {
      // Store may be unavailable — skip rescue, worker loop will handle errors
    }

    for (let i = 0; i < this.config.concurrency; i++) {
      this.loops.push(this.workerLoop(i));
    }
    this.sweepTimer = setInterval(() => {
      for (const type of this.processors.keys()) {
        this.queue.promoteDelayed(type).catch(() => undefined);
      }
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all(this.loops);
  }

  private async workerLoop(index: number): Promise<void> {
    const owner = `${this.ownerPrefix}_${index}`;
    while (this.running && !this.abort.signal.aborted) {
      let processed = false;
      for (const type of this.processors.keys()) {
        const job = await this.queue.dequeue(type);
        if (job) {
          await this.processJob(job, owner);
          processed = true;
          break;
        }
      }
      if (!processed) {
        await this.sleep(this.config.pollIntervalMs);
      }
    }
  }

  private async processJob(job: Job, owner: string): Promise<void> {
    const processor = this.processors.get(job.type);
    if (!processor) {
      await this.queue.deadLetter(job);
      return;
    }

    if (job.idempotencyKey) {
      const state = await this.idempotency.claim(job.idempotencyKey);
      if (state === 'completed' || state === 'processing') {
        await this.queue.complete(job);
        return;
      }
    }

    const ctx: WorkerContext = { store: this.store, signal: this.abort.signal };

    this._inFlight++;
    try {
      await processor(job, ctx);
      if (job.idempotencyKey) {
        await this.idempotency.complete(job.idempotencyKey, { id: job.id });
      }
      await this.queue.complete(job);
    } catch (err: any) {
      if (job.idempotencyKey) {
        await this.idempotency.release(job.idempotencyKey);
      }
      await this.queue.fail(job, err);
    } finally {
      this._inFlight--;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
