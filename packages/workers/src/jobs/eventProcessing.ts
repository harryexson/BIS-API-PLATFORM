import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';
import { EventRecord } from '@company/database';

export function toEventRecord(payload: any, category: string): EventRecord {
  return {
    appId: payload.appId || 'system',
    category,
    providerId: payload.providerId || payload.provider || null,
    status: payload.status || 'success',
    amount: payload.amount != null ? String(payload.amount) : null,
    currency: payload.currency || null,
    latency: payload.latency != null ? Number(payload.latency) : null,
    cost: payload.cost != null ? String(payload.cost) : null,
    decisionReason: payload.decisionReason || null,
    payload: payload.payload ?? payload,
    response: payload.response ?? null,
    error: payload.error ?? null,
    createdAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
  } as EventRecord;
}

export function createEventProcessingProcessor(deps: JobDeps): JobProcessor {
  return async (job) => {
    const record = toEventRecord(job.payload, job.payload.category || 'event');
    try {
      await eventRepository.create(record);
    } catch (err) {
      // P1: Fail the job on DB error so it can be retried — previously this
      // was silently swallowed and the job was marked complete.
      console.error('[event_processing] Neon write failed — failing job for retry', err);
      throw new Error('event_processing: database write failed — retrying');
    }
    deps.eventBus.emit(job.payload as any);
  };
}
