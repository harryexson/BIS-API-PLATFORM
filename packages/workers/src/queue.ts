import { KVStore } from './store';
import { Keys } from './keys';
import { Job, JobType, JobPayload, EnqueueOptions, WorkerConfig, newJobId } from './types';
import { computeBackoff } from './backoff';

export class JobQueue {
  constructor(
    private store: KVStore,
    private keys: Keys,
    private config: WorkerConfig,
  ) {}

  async enqueue(
    type: JobType,
    payload: JobPayload,
    opts: EnqueueOptions = {},
  ): Promise<Job> {
    const id = newJobId();
    const now = Date.now();
    const maxAttempts = opts.maxAttempts ?? this.config.retry.maxAttempts;
    const runAt = opts.runAt ?? (opts.delayMs ? now + opts.delayMs : now);

    const job: Job = {
      id,
      type,
      payload,
      attempts: 0,
      maxAttempts,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      runAt,
      idempotencyKey: opts.idempotencyKey,
    };

    await this.store.set(this.keys.job(id), JSON.stringify(job), this.jobTtl());

    if (runAt > now) {
      await this.store.zadd(this.keys.delayed(type), runAt, id);
    } else {
      await this.store.rpush(this.keys.ready(type), id);
      await this.store.publish(this.keys.notify(type), id);
    }

    return job;
  }

  async enqueueDead(job: Job): Promise<Job> {
    const fresh: Job = {
      ...job,
      id: newJobId(),
      attempts: 0,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runAt: Date.now(),
      deadRetries: (job.deadRetries ?? 0) + 1,
      lastError: undefined,
    };
    await this.store.set(this.keys.job(fresh.id), JSON.stringify(fresh), this.jobTtl());
    await this.store.rpush(this.keys.ready(fresh.type), fresh.id);
    await this.store.publish(this.keys.notify(fresh.type), fresh.id);
    return fresh;
  }

  async dequeue(type: JobType): Promise<Job | null> {
    const ready = await this.store.llen(this.keys.ready(type));
    if (ready === 0) {
      await this.promoteDelayed(type);
    }

    const id = await this.store.lpop(this.keys.ready(type));
    if (!id) return null;

    const raw = await this.store.get(this.keys.job(id));
    if (!raw) return null;

    const job = JSON.parse(raw) as Job;
    if (job.status === 'dead') return null;

    job.status = 'processing';
    job.updatedAt = Date.now();
    await this.store.set(this.keys.job(id), JSON.stringify(job), this.jobTtl());

    return job;
  }

  async promoteDelayed(type: JobType): Promise<void> {
    const now = Date.now();
    const due = await this.store.zrangebyscore(this.keys.delayed(type), 0, now);
    if (due.length === 0) return;

    for (const id of due) {
      await this.store.zrem(this.keys.delayed(type), id);
      await this.store.rpush(this.keys.ready(type), id);
    }
    await this.store.publish(this.keys.notify(type), 'promoted');
  }

  async complete(job: Job): Promise<void> {
    job.status = 'completed';
    job.updatedAt = Date.now();
    await this.store.set(this.keys.job(job.id), JSON.stringify(job), this.jobTtl());
  }

  async fail(job: Job, error: Error | string): Promise<Job> {
    job.attempts += 1;
    job.lastError = typeof error === 'string' ? error : error.message;
    job.updatedAt = Date.now();

    if (job.attempts >= job.maxAttempts) {
      job.status = 'dead';
      await this.store.set(this.keys.job(job.id), JSON.stringify(job), this.jobTtl());
      await this.store.rpush(this.keys.dead(job.type), job.id);
      return job;
    }

    const delay = computeBackoff(job.attempts, this.config.retry);
    job.status = 'pending';
    job.runAt = Date.now() + delay;
    await this.store.set(this.keys.job(job.id), JSON.stringify(job), this.jobTtl());
    await this.store.zadd(this.keys.delayed(job.type), job.runAt, job.id);
    return job;
  }

  async deadLetter(job: Job): Promise<void> {
    job.status = 'dead';
    job.updatedAt = Date.now();
    await this.store.set(this.keys.job(job.id), JSON.stringify(job), this.jobTtl());
    await this.store.rpush(this.keys.dead(job.type), job.id);
  }

  async getJob(id: string): Promise<Job | null> {
    const raw = await this.store.get(this.keys.job(id));
    return raw ? (JSON.parse(raw) as Job) : null;
  }

  async deadJobs(type: JobType): Promise<string[]> {
    return this.store.lrange(this.keys.dead(type), 0, -1);
  }

  async removeDead(type: JobType, id: string): Promise<void> {
    await this.store.lrem(this.keys.dead(type), id);
  }

  async deadCount(type: JobType): Promise<number> {
    return this.store.llen(this.keys.dead(type));
  }

  async readyCount(type: JobType): Promise<number> {
    return this.store.llen(this.keys.ready(type));
  }

  async delayedCount(type: JobType): Promise<number> {
    return this.store.zcard(this.keys.delayed(type));
  }

  /**
   * P1: Rescues jobs stuck in 'processing' state (e.g., after worker crash).
   * Scans all job keys, finds jobs with status 'processing' and updatedAt
   * older than staleThresholdMs, resets them to 'pending' and re-enqueues.
   */
  async rescueStuckJobs(staleThresholdMs: number = 5 * 60_000): Promise<number> {
    if (!this.store.keys) return 0;

    const pattern = `${this.keys.job('*')}`;
    const jobKeys = await this.store.keys(pattern);
    let rescued = 0;

    for (const key of jobKeys) {
      const raw = await this.store.get(key);
      if (!raw) continue;

      const job = JSON.parse(raw) as Job;
      if (job.status !== 'processing') continue;

      const staleMs = Date.now() - job.updatedAt;
      if (staleMs < staleThresholdMs) continue;

      job.status = 'pending';
      job.runAt = Date.now();
      job.updatedAt = Date.now();
      job.lastError = 'rescued from stuck processing state';

      await this.store.set(key, JSON.stringify(job), this.jobTtl());
      await this.store.rpush(this.keys.ready(job.type), job.id);
      rescued++;
    }

    return rescued;
  }

  private jobTtl(): number {
    return this.config.idempotencyTtlMs;
  }
}
