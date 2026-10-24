import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { neon } from '@neondatabase/serverless';
import { logger } from '@company/observability';

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.error('DATABASE_URL environment variable is not set', {
      operation: 'db-migrate',
      errorCode: 'DATABASE_URL_MISSING',
      status: 'failed',
    });
    process.exit(1);
  }

  const sql = neon(connectionString);
  const db = drizzle(sql);

  logger.info('running migrations', { operation: 'db-migrate', status: 'started' });
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    logger.info('migrations completed', { operation: 'db-migrate', status: 'completed' });
  } catch (error) {
    logger.error('migration failed', {
      operation: 'db-migrate',
      errorCode: 'MIGRATION_FAILED',
      status: 'failed',
      error,
    });
    process.exit(1);
  }
}

runMigrations();
