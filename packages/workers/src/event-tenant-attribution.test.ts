import { describe, vi } from 'vitest';

/**
 * Phase 16 — events.tenant_id attribution, in-memory back-end (no database).
 * eventRepository.create is replaced by a store with the column's own
 * semantics: an omitted tenantId gets the column default 'default'. The
 * real-PostgreSQL run of the same scenarios is
 * event-tenant-attribution.postgres.integration.test.ts.
 */

const store = vi.hoisted(() => ({ rows: [] as Array<{ tenantId: string | null; decisionReason: string | null }> }));

vi.mock('@company/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    eventRepository: {
      async create(data: Record<string, unknown>) {
        const row = {
          tenantId: data.tenantId === undefined ? 'default' : (data.tenantId as string | null),
          decisionReason: (data.decisionReason as string | null) ?? null,
        };
        store.rows.push(row);
        return row;
      },
    },
  };
});

import { registerEventTenantAttributionScenarios, registerEventWriterStaticGuard } from './event-tenant-attribution.scenarios';

describe('Phase 16 — events.tenant_id attribution (in-memory)', () => {
  registerEventTenantAttributionScenarios(() => ({
    appId: 'p16-app',
    async storedTenantOf(decisionReason: string) {
      const rows = store.rows.filter((r) => r.decisionReason === decisionReason);
      if (rows.length !== 1) throw new Error(`expected exactly one events row for ${decisionReason}, found ${rows.length}`);
      return rows[0].tenantId;
    },
  }));
  registerEventWriterStaticGuard();
});
