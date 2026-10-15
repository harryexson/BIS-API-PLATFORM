/**
 * Test fixture (not production code): a separate OS process playing an
 * outbox worker that CRASHES mid-dispatch. It runs the real outbox poll
 * (runOutboxPollOnce) against the real repository; its dispatcher records
 * the row it was handed and then SIGKILLs its own process — no completion,
 * no failure write, no cleanup, no graceful shutdown. Whatever it claimed is
 * left `processing` in Postgres with a claim nobody will ever finish.
 *
 * Used by outbox.postgres.integration.test.ts:
 *   node --import tsx packages/database/src/test-fixtures/outbox-crash-worker.ts <dbUrl> <batchSize>
 * (run directly under node, not via the tsx CLI wrapper, so the spawning
 * test observes the SIGKILL itself rather than a wrapper's exit code 137).
 *
 * Output (written synchronously before the kill, one JSON line):
 *   {"pid":123,"dispatching":"<outbox id>","claimToken":"<token>"}
 */
import { writeSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createOutboxEventRepository } from '../repositories/outbox-events';
import { runOutboxPollOnce } from '../../../workers/src/jobs/outboxPoller';

async function main(): Promise<void> {
  const [dbUrl, batchSize] = process.argv.slice(2);
  const client = postgres(dbUrl, { max: 2, onnotice: () => {} });
  const repo = createOutboxEventRepository(() => drizzle(client) as never);
  await runOutboxPollOnce(
    repo,
    async (row) => {
      writeSync(1, `${JSON.stringify({ pid: process.pid, dispatching: row.id, claimToken: row.claimToken })}\n`);
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => undefined);
    },
    { batchSize: Number(batchSize) || 1, staleAfterMs: 60_000 },
  );
  // Only reached if nothing was claimed.
  writeSync(1, `${JSON.stringify({ pid: process.pid, dispatching: null })}\n`);
  await client.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
