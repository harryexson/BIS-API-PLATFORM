import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Job } from './types';
import type { JobDeps } from './jobs/deps';
import { createMessageDeliveryProcessor } from './jobs/messageDelivery';
import { createEventProcessingProcessor } from './jobs/eventProcessing';
import { createKeywordResponseDeliveryProcessor } from './jobs/keywordResponseDelivery';

/**
 * Phase 16 (gap register D14 / D16 "events.tenant_id") — every worker that
 * writes an `events` row while KNOWING the tenant must store it in the
 * tenant_id column. Before this phase each of them put the tenant only into
 * the JSON payload and omitted the column, so the column default 'default'
 * applied: every tenant's messaging, keyword and inbound events were stored
 * as tenant 'default' and were invisible to a tenant-scoped query
 * (eventRepository.findByAppAndTenant).
 *
 * Run against two back-ends (the dual-coverage pattern used across this
 * repo):
 *   - event-tenant-attribution.test.ts — eventRepository.create mocked with
 *     the column's semantics (omitted ⇒ 'default');
 *   - event-tenant-attribution.postgres.integration.test.ts — the real
 *     repository against a real PostgreSQL migrated from zero.
 * The inbound-message and keyword-audit writers are covered end to end by
 * shared-number.scenarios.ts (Scenario 6) on the same two back-ends.
 */

export interface EventTenantBackend {
  appId: string;
  /** tenant_id of the single stored events row with this decision_reason. */
  storedTenantOf(decisionReason: string): Promise<string | null>;
}

let seq = 0;
function job(type: Job['type'], payload: Record<string, unknown>): Job {
  seq += 1;
  const now = Date.now();
  return { id: `p16_${seq}`, type, payload, attempts: 0, maxAttempts: 3, status: 'processing', createdAt: now, updatedAt: now, runAt: now } as Job;
}

function deps(appId: string, decisionReason: string, opts: { consentBlocked?: boolean } = {}): JobDeps {
  return {
    routing: {
      async routeMessage() {
        if (opts.consentBlocked) {
          const err = new Error('recipient opted out');
          err.name = 'ConsentBlockedError';
          throw err;
        }
        return {
          id: `evt_${seq}`,
          timestamp: new Date().toISOString(),
          appId,
          category: 'messaging',
          providerId: 'twilio',
          status: 'success',
          latency: 1,
          cost: 0,
          decisionReason,
          payload: {},
          response: null,
        };
      },
    },
    eventBus: { async emit() {} },
    rateLimiter: { async limit() { return { allowed: true, remaining: 1, resetMs: 0 }; } },
  } as unknown as JobDeps;
}

export function registerEventTenantAttributionScenarios(getBackend: () => EventTenantBackend): void {
  const ctx = {} as Parameters<ReturnType<typeof createMessageDeliveryProcessor>>[1];

  describe('message_delivery', () => {
    it("stores the job's tenant in events.tenant_id", async () => {
      const b = getBackend();
      const reason = `p16_md_tenant_${seq + 1}`;
      await createMessageDeliveryProcessor(deps(b.appId, reason))(
        job('message_delivery', { appId: b.appId, recipient: '+15550161001', content: 'hi', tenantId: 'tenant-a' }),
        ctx,
      );
      expect(await b.storedTenantOf(reason)).toBe('tenant-a');
    });

    it("an untenanted job (platform-level) still falls back to 'default' — unchanged", async () => {
      const b = getBackend();
      const reason = `p16_md_untenanted_${seq + 1}`;
      await createMessageDeliveryProcessor(deps(b.appId, reason))(
        job('message_delivery', { appId: b.appId, recipient: '+15550161002', content: 'hi' }),
        ctx,
      );
      expect(await b.storedTenantOf(reason)).toBe('default');
    });
  });

  describe('event_processing', () => {
    it("stores the event's own tenant (Phase 7 put it on every TransactionEvent)", async () => {
      const b = getBackend();
      const reason = `p16_ep_tenant_${seq + 1}`;
      await createEventProcessingProcessor(deps(b.appId, reason))(
        job('event_processing', { appId: b.appId, tenantId: 'tenant-b', category: 'payment', status: 'success', decisionReason: reason }),
        ctx,
      );
      expect(await b.storedTenantOf(reason)).toBe('tenant-b');
    });

    it("a platform-level event with no tenant keeps 'default'", async () => {
      const b = getBackend();
      const reason = `p16_ep_platform_${seq + 1}`;
      await createEventProcessingProcessor(deps(b.appId, reason))(
        job('event_processing', { appId: b.appId, category: 'other', status: 'success', decisionReason: reason }),
        ctx,
      );
      expect(await b.storedTenantOf(reason)).toBe('default');
    });
  });

  describe('keyword_response_delivery', () => {
    it("the sent reply's audit event carries the conversation's tenant", async () => {
      const b = getBackend();
      await createKeywordResponseDeliveryProcessor(deps(b.appId, 'ignored'))(
        job('keyword_response_delivery', { appId: b.appId, senderPhone: '+15550161003', content: 'Help text', tenantId: 'tenant-c', keyword: `help${seq + 1}` }),
        ctx,
      );
      expect(await b.storedTenantOf(`keyword_response:help${seq}`)).toBe('tenant-c');
    });

    it('a reply suppressed by an opt-out is audited under the tenant too', async () => {
      const b = getBackend();
      await createKeywordResponseDeliveryProcessor(deps(b.appId, 'ignored', { consentBlocked: true }))(
        job('keyword_response_delivery', { appId: b.appId, senderPhone: '+15550161004', content: 'Help text', tenantId: 'tenant-d', keyword: `help${seq + 1}` }),
        ctx,
      );
      expect(await b.storedTenantOf(`keyword_response_suppressed:help${seq}`)).toBe('tenant-d');
    });
  });
}

/**
 * Static guard (the where-clause-and.test.ts pattern): every literal
 * `eventRepository.create({ ... })` in production worker/routing code names
 * tenantId, so a new writer cannot silently reintroduce the 'default'
 * attribution. receiptPipeline.ts is the one documented exception: no
 * production code enqueues receipt_pipeline, and its job carries no tenant
 * to store (Phase 16 report, PHASE16 finding).
 */
export function registerEventWriterStaticGuard(): void {
  const roots = [path.resolve(__dirname, 'jobs'), path.resolve(__dirname, '../../routing/src')];
  const EXEMPT = new Set(['receiptPipeline.ts']);

  describe('every events writer that knows the tenant stores it (static scan)', () => {
    const sites: Array<{ file: string; call: string }> = [];
    for (const dir of roots) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.scenarios.'))) {
        const src = readFileSync(path.join(dir, file), 'utf8');
        let i = src.indexOf('eventRepository.create({');
        while (i !== -1) {
          sites.push({ file, call: src.slice(i, src.indexOf('});', i)) });
          i = src.indexOf('eventRepository.create({', i + 1);
        }
      }
    }

    it('found the known writers (sanity check the scan itself runs)', () => {
      expect(sites.length).toBeGreaterThanOrEqual(6);
    });

    for (const [n, site] of sites.entries()) {
      if (EXEMPT.has(site.file)) continue;
      it(`${site.file} write #${n} sets tenantId`, () => {
        expect(site.call).toMatch(/\btenantId\b/);
      });
    }
  });
}
