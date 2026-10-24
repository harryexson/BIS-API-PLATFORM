import { generateDrizzleJson } from 'drizzle-kit/api';
import type postgres from 'postgres';
import * as schema from '../schema';

type Sql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Schema fingerprints: one sorted line per table / column / key / index /
// constraint, from (a) drizzle-kit's serialisation of src/schema and (b) the
// live pg_catalog. Names, columns, uniqueness, partial-ness, nullability,
// default presence and FK actions are compared; SQL expression text (CHECK
// bodies, index predicates, default values) is not, because Postgres
// re-renders it.
//
// Test-only. Shared by the Phase 16 drift guard
// (database-integrity.postgres.integration.test.ts) and the Phase 25
// backup/restore round trip (backup-restore.postgres.integration.test.ts).
// ---------------------------------------------------------------------------

const ON_DELETE: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

export function expectedFingerprint(): string[] {
  const snap = generateDrizzleJson(schema as unknown as Record<string, unknown>) as unknown as {
    tables: Record<string, any>;
  };
  const out: string[] = [];
  for (const t of Object.values(snap.tables)) {
    out.push(`table ${t.name}`);
    const pk: string[] = [];
    for (const c of Object.values<any>(t.columns)) {
      out.push(`column ${t.name}.${c.name} ${c.type} notnull=${!!(c.notNull || c.primaryKey)} default=${c.default !== undefined}`);
      if (c.primaryKey) pk.push(c.name);
    }
    for (const cpk of Object.values<any>(t.compositePrimaryKeys ?? {})) pk.push(...cpk.columns);
    if (pk.length) out.push(`pk ${t.name} (${[...pk].sort().join(',')})`);
    for (const ix of Object.values<any>(t.indexes)) {
      const cols = ix.columns.map((c: any) => (c.isExpression ? 'expr' : c.expression)).join(',');
      out.push(`index ${t.name}.${ix.name} unique=${!!ix.isUnique} partial=${!!ix.where} (${cols})`);
    }
    for (const fk of Object.values<any>(t.foreignKeys)) {
      out.push(`fk ${t.name}.${fk.name} (${fk.columnsFrom.join(',')}) -> ${fk.tableTo}(${fk.columnsTo.join(',')}) on delete ${fk.onDelete ?? 'no action'}`);
    }
    for (const u of Object.values<any>(t.uniqueConstraints)) {
      out.push(`unique ${t.name}.${u.name} (${u.columns.join(',')}) nulls_not_distinct=${!!u.nullsNotDistinct}`);
    }
    for (const ck of Object.values<any>(t.checkConstraints)) out.push(`check ${t.name}.${ck.name}`);
  }
  return out.sort();
}

export async function actualFingerprint(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  const tables = await sql<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`;
  for (const t of tables) out.push(`table ${t.name}`);

  const cols = await sql<{ t: string; c: string; type: string; notnull: boolean; hasdef: boolean }[]>`
    SELECT cl.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS notnull, (ad.adbin IS NOT NULL) AS hasdef
    FROM pg_attribute a
    JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public' AND cl.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`;
  for (const c of cols) out.push(`column ${c.t}.${c.c} ${c.type} notnull=${c.notnull} default=${c.hasdef}`);

  const cons = await sql<{ t: string; name: string; type: string; cols: string[]; to_t: string | null; to_cols: string[] | null; del: string; nnd: boolean | null }[]>`
    SELECT cl.relname AS t, con.conname AS name, con.contype AS type,
      array(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
      f.relname AS to_t,
      array(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o) AS to_cols,
      con.confdeltype AS del, ix.indnullsnotdistinct AS nnd
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_class f ON f.oid = con.confrelid
    LEFT JOIN pg_index ix ON ix.indexrelid = con.conindid
    WHERE n.nspname = 'public' AND con.contype IN ('p', 'f', 'u', 'c')`;
  for (const c of cons) {
    if (c.type === 'p') out.push(`pk ${c.t} (${[...c.cols].sort().join(',')})`);
    if (c.type === 'f') out.push(`fk ${c.t}.${c.name} (${c.cols.join(',')}) -> ${c.to_t}(${(c.to_cols ?? []).join(',')}) on delete ${ON_DELETE[c.del]}`);
    if (c.type === 'u') out.push(`unique ${c.t}.${c.name} (${c.cols.join(',')}) nulls_not_distinct=${!!c.nnd}`);
    if (c.type === 'c') out.push(`check ${c.t}.${c.name}`);
  }

  const idx = await sql<{ t: string; name: string; uniq: boolean; partial: boolean; cols: string[] }[]>`
    SELECT t.relname AS t, i.relname AS name, ix.indisunique AS uniq, (ix.indpred IS NOT NULL) AS partial,
      array(SELECT COALESCE(a.attname::text, 'expr') FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(n, o)
            LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.n ORDER BY k.o) AS cols
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u'))`;
  for (const i of idx) out.push(`index ${i.t}.${i.name} unique=${i.uniq} partial=${i.partial} (${i.cols.join(',')})`);
  return out.sort();
}

export function diff(expected: string[], actual: string[]) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    declaredButMissingFromMigratedDb: expected.filter((x) => !a.has(x)),
    inMigratedDbButNotDeclared: actual.filter((x) => !e.has(x)),
  };
}
