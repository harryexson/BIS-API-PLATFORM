import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Phase 16 (gap register D16): providerHealthRepository.pruneOlderThan used
 * `eq(checkedAt, cutoff)`, which deletes only a row whose timestamp equals
 * the computed cutoff to the microsecond — i.e. nothing — so provider_health
 * grew without bound. In-memory half of the dual coverage: captures the
 * exact WHERE clause the repository hands the driver and renders it with
 * drizzle's own Postgres dialect. The real-database half (old + new rows,
 * only the old ones deleted) is in
 * database-integrity.postgres.integration.test.ts.
 */

const captured = vi.hoisted(() => ({ where: undefined as unknown }));

vi.mock('../connection', () => ({
  getDb: () => ({
    delete: () => ({
      where: (condition: unknown) => {
        captured.where = condition;
        return { returning: async () => [{ id: 'a' }, { id: 'b' }] };
      },
    }),
  }),
}));

import { providerHealthRepository } from './provider-health';

describe('providerHealthRepository.pruneOlderThan (D16) — no DB required', () => {
  beforeEach(() => {
    captured.where = undefined;
  });

  it('deletes rows checked strictly BEFORE the cutoff (checked_at < cutoff), not only rows equal to it', async () => {
    const before = Date.now();
    const removed = await providerHealthRepository.pruneOlderThan(30);
    const after = Date.now();

    expect(removed).toBe(2);
    const query = new PgDialect().sqlToQuery(captured.where as SQL);
    expect(query.sql).toBe('"provider_health"."checked_at" < $1');
    expect(query.params).toHaveLength(1);

    // The single parameter is "now minus 30 days".
    const cutoff = new Date(query.params[0] as string | Date).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    // setDate() is calendar arithmetic, so allow a DST hour either way.
    expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDays - 3_600_000);
    expect(cutoff).toBeLessThanOrEqual(after - thirtyDays + 3_600_000);
  });
});
