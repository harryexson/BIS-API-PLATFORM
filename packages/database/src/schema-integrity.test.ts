import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * Phase 16 — database integrity audit (gap register D14, D15, D16), the
 * in-memory half of the dual coverage. No database: these assertions read
 * the TypeScript schema (what drizzle-kit diffs against), the migration
 * journal and the snapshot chain. The real-PostgreSQL half —
 * database-integrity.postgres.integration.test.ts — proves a database
 * migrated from zero actually has every property asserted here.
 */

const DRIZZLE_DIR = path.resolve(__dirname, '../drizzle');
const META_DIR = path.join(DRIZZLE_DIR, 'meta');

function cfg(table: PgTable) {
  return getTableConfig(table);
}

// The free-text tenant_id columns (users / tenant_application_links hold a
// real uuid FK to tenants.id and are not in this list).
const FREE_TEXT_TENANT_TABLES: Array<[string, PgTable]> = [
  ['checkout_sessions', schema.checkoutSessions],
  ['consent_records', schema.consentRecords],
  ['conversations', schema.conversations],
  ['events', schema.events],
  ['idempotency_records', schema.idempotencyRecords],
  ['keyword_command_dispatches', schema.keywordCommandDispatches],
  ['keyword_commands', schema.keywordCommands],
  ['messaging_profiles', schema.messagingProfiles],
  ['suppliers', schema.suppliers],
  ['transactions', schema.transactions],
  ['webhook_endpoints', schema.webhookEndpoints],
  ['webhook_events', schema.webhookEvents],
];

// NOT NULL free-text tenant columns: no silent 'default' fallback.
const NO_DEFAULT_TENANT_TABLES = [
  'checkout_sessions',
  'consent_records',
  'conversations',
  'idempotency_records',
  'messaging_profiles',
  'transactions',
  'webhook_endpoints',
];

describe('D14 — tenant identifiers (schema)', () => {
  it('every free-text tenant_id table is covered (no new one slipped in unlisted)', () => {
    const withTextTenant = (Object.values(schema) as unknown[])
      .filter((v): v is PgTable => typeof v === 'object' && v !== null && Symbol.for('drizzle:IsDrizzleTable') in v)
      .map(cfg)
      .filter((c) => c.columns.some((col) => col.name === 'tenant_id' && col.getSQLType() === 'text'))
      .map((c) => c.name)
      .sort();
    expect(withTextTenant).toEqual(FREE_TEXT_TENANT_TABLES.map(([n]) => n).sort());
  });

  for (const name of NO_DEFAULT_TENANT_TABLES) {
    it(`${name}.tenant_id is NOT NULL with NO default — an omitted tenant fails loudly instead of becoming 'default'`, () => {
      const table = FREE_TEXT_TENANT_TABLES.find(([n]) => n === name)![1];
      const col = cfg(table).columns.find((c) => c.name === 'tenant_id')!;
      expect(col.notNull).toBe(true);
      expect(col.hasDefault).toBe(false);
    });
  }

  it("events.tenant_id deliberately keeps its nullable 'default' fallback (platform-level events have no tenant)", () => {
    const col = cfg(schema.events).columns.find((c) => c.name === 'tenant_id')!;
    expect(col.notNull).toBe(false);
    expect(col.default).toBe('default');
  });

  for (const [name, table] of FREE_TEXT_TENANT_TABLES) {
    it(`${name} rejects a blank tenant_id (CHECK chk_${name}_tenant_id_nonblank)`, () => {
      expect(cfg(table).checks.map((c) => c.name)).toContain(`chk_${name}_tenant_id_nonblank`);
    });
  }
});

describe('D16 — audit trail and conversation key (schema)', () => {
  it('audit_logs.application_id is ON DELETE RESTRICT — deleting an application cannot strip its audit attribution', () => {
    const fk = cfg(schema.auditLogs).foreignKeys.find((f) => f.reference().columns[0].name === 'application_id')!;
    expect(fk.onDelete).toBe('restrict');
  });

  it('the conversation ownership key includes channel (an SMS and a WhatsApp thread of one owner are distinct rows)', () => {
    const uq = cfg(schema.conversations).uniqueConstraints.find((u) => u.name === 'uq_conversations_owner')!;
    expect(uq.columns.map((c) => c.name)).toEqual(['phone_number', 'business_number', 'app_id', 'tenant_id', 'supplier_id', 'channel']);
    expect(uq.nullsNotDistinct).toBe(true);
  });
});

describe('D15 — migration chain integrity (journal + snapshots)', () => {
  const journal = JSON.parse(readFileSync(path.join(META_DIR, '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const sqlFiles = readdirSync(DRIZZLE_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  it('every migration file has exactly one journal entry with the same index and tag, and vice versa', () => {
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(sqlFiles);
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.slice(0, 4)).toBe(String(i).padStart(4, '0'));
    });
  });

  it('journal "when" is strictly increasing (a lower stamp makes drizzle-orm\'s migrator skip that migration forever)', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when, journal.entries[i].tag).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  // The historical gap: snapshots for 0002-0010 were never committed (their
  // migrations were hand-written). Regenerating them now would mean
  // inventing schema states nobody recorded and rewriting 0011's prevId —
  // see the Phase 16 report. drizzle-kit only ever diffs against the LATEST
  // snapshot, and the drift guard in database-integrity.postgres.integration
  // .test.ts checks that snapshot's schema against a really-migrated
  // database, which is what the missing snapshots were failing to protect.
  // This list may only shrink: any NEW gap fails.
  const KNOWN_MISSING_SNAPSHOTS = ['0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010'];

  it('every migration since 0011 has a snapshot; the only gap is the known historical 0002-0010', () => {
    const missing = journal.entries
      .map((e) => e.tag.slice(0, 4))
      .filter((n) => !existsSync(path.join(META_DIR, `${n}_snapshot.json`)));
    expect(missing).toEqual(KNOWN_MISSING_SNAPSHOTS);
  });

  it('the snapshot id/prevId chain is unbroken across the snapshots that exist, and ends at the latest migration', () => {
    const snaps = readdirSync(META_DIR)
      .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(META_DIR, f), 'utf8')) as { id: string; prevId: string });
    expect(snaps[0].prevId).toBe('00000000-0000-0000-0000-000000000000');
    for (let i = 1; i < snaps.length; i++) expect(snaps[i].prevId).toBe(snaps[i - 1].id);
    expect(new Set(snaps.map((s) => s.id)).size).toBe(snaps.length);
    const last = journal.entries[journal.entries.length - 1].tag.slice(0, 4);
    expect(existsSync(path.join(META_DIR, `${last}_snapshot.json`))).toBe(true);
  });
});

describe('D16 — one drizzle-kit for the whole repository', () => {
  const root = path.resolve(__dirname, '../../..');
  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dbPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

  it('the root and @company/database declare the same drizzle-kit range', () => {
    expect(dbPkg.devDependencies['drizzle-kit']).toBe(rootPkg.devDependencies['drizzle-kit']);
  });

  it('the drizzle-kit this package resolves can itself resolve drizzle-orm (otherwise `drizzle-kit check` in CI fails with "Please install latest version of drizzle-orm")', () => {
    // drizzle-kit's/drizzle-orm's "exports" hide package.json; resolve real
    // entry points (both live at their package roots).
    const kitDir = path.dirname(require.resolve('drizzle-kit/api', { paths: [path.resolve(__dirname, '..')] }));
    const ormFromKit = require.resolve('drizzle-orm', { paths: [kitDir] });
    const ormFromDb = require.resolve('drizzle-orm', { paths: [path.resolve(__dirname, '..')] });
    expect(ormFromKit).toBe(ormFromDb);
    expect(JSON.parse(readFileSync(path.join(kitDir, 'package.json'), 'utf8')).version).toMatch(/^0\.31\./);
  });
});
