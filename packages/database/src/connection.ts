import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import { drizzle, NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';

let sql: NeonQueryFunction<false, false>;
let db: NeonHttpDatabase<typeof schema>;

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is not set. ' +
        'Set it to your Neon PostgreSQL connection string.',
    );
  }
  return url;
}

export function getDb(): NeonHttpDatabase<typeof schema> {
  if (!db) {
    const connectionString = getConnectionString();
    sql = neon(connectionString);
    db = drizzle(sql, { schema });
  }
  return db;
}

export function getRawSql() {
  if (!sql) {
    getDb();
  }
  return sql!;
}

export async function checkDatabaseHealth(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  details: Record<string, unknown>;
}> {
  const start = Date.now();
  try {
    const rawSql = getRawSql();
    const result = await rawSql`SELECT 1 AS ok, current_database() AS db_name, version() AS version`;
    const latencyMs = Date.now() - start;

    const status = latencyMs < 200 ? 'healthy' : latencyMs < 1000 ? 'degraded' : 'unhealthy';

    return {
      status,
      latencyMs,
      details: {
        database: result[0]?.db_name ?? 'unknown',
        version: result[0]?.version ?? 'unknown',
      },
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

export { schema };
export type { NeonHttpDatabase };
