import { JobProcessor } from '../types';
import { JobDeps } from './deps';
import { eventRepository } from '@company/database';
import { EventRecord } from '@company/database';

export function toEventRecord(payload: any, category: string): EventRecord {
  return {
    appId: payload.appId || 'system',
    // Phase 16 (gap register D14/D16): the event's own tenant (Phase 7 put
    // it on every TransactionEvent) — previously dropped, so the row fell
    // back to the column default 'default'. Absent = a platform-level event.
    ...(typeof payload.tenantId === 'string' && payload.tenantId ? { tenantId: payload.tenantId } : {}),
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
    // Phase 10: a messaging event's channel decision (migration 0019).
    requestedChannel: typeof payload.requestedChannel === 'string' ? payload.requestedChannel : null,
    selectedChannel: typeof payload.selectedChannel === 'string' ? payload.selectedChannel : null,
    fallbackReason: typeof payload.fallbackReason === 'string' ? payload.fallbackReason : null,
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
    await deps.eventBus.emit(job.payload as any);
  };
}
