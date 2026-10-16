/**
 * Test fixture (not production code): a brand-new OS process that plays a
 * RESTARTED gateway. It shares nothing with the test process — no module
 * state, no in-memory map, no queue, no connection pool — only the Postgres
 * database. It runs the real ingest pipeline for each delivery given on argv
 * and prints one JSON line with the outcomes.
 *
 * Used by webhook-pipeline.postgres.integration.test.ts:
 *   tsx packages/database/src/test-fixtures/webhook-redeliver.ts <dbUrl> '<json deliveries>'
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createWebhookEventRepository } from '../repositories/webhook-events';
import { ingestWebhook, type WebhookIngestInput } from '../../../workers/src/webhookEvents';

async function main(): Promise<void> {
  const [dbUrl, deliveriesJson] = process.argv.slice(2);
  const client = postgres(dbUrl, { max: 2, onnotice: () => {} });
  const repo = createWebhookEventRepository(() => drizzle(client) as never);
  const enqueued: Array<{ type: string; webhookEventId: unknown }> = [];
  const outcomes: Array<{ providerEventId: string; kind: string; webhookEventId?: string }> = [];
  try {
    for (const d of JSON.parse(deliveriesJson) as WebhookIngestInput[]) {
      const outcome = await ingestWebhook(
        {
          store: repo,
          enqueue: async (type, payload) => {
            enqueued.push({ type, webhookEventId: payload.webhookEventId });
          },
        },
        d,
      );
      outcomes.push({
        providerEventId: d.providerEventId,
        kind: outcome.kind,
        webhookEventId: 'event' in outcome ? outcome.event.id : undefined,
      });
    }
    process.stdout.write(`${JSON.stringify({ pid: process.pid, outcomes, enqueued })}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
});
