/**
 * Test fixture (not production code): one EventBus in its own OS process,
 * playing either side of the gateway/worker split. Uses REDIS_URL from the
 * environment, exactly like the services do.
 *
 *   tsx packages/events/src/test-fixtures/eventbus-peer.ts listen <ms>
 *     the GATEWAY role: subscribes a local listener the way
 *     services/api-gateway/src/app.ts does for outbound webhook dispatch,
 *     prints {"ready":true} once connected, listens for <ms>, then prints
 *     the ids it received.
 *   tsx packages/events/src/test-fixtures/eventbus-peer.ts emit <eventId>
 *     the WORKER role: publishes one event with emitOrThrow() (the outbox
 *     poller's path — it throws if the publish did not reach Redis).
 *
 * Used by eventbus-multiprocess.redis.test.ts (gap register PHASE7-01).
 */
import { EventBus } from '../index';

async function waitConnected(bus: EventBus): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (bus.getRedisStatus() !== 'connected') {
    if (Date.now() > deadline) throw new Error(`EventBus never connected (${bus.getRedisStatus()})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main(): Promise<void> {
  const [mode, arg] = process.argv.slice(2);
  const bus = EventBus.getInstance();
  await waitConnected(bus);

  if (mode === 'listen') {
    const received: string[] = [];
    bus.subscribe((event) => received.push(event.id));
    process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
    await new Promise((r) => setTimeout(r, Number(arg)));
    process.stdout.write(`${JSON.stringify({ pid: process.pid, received })}\n`);
  } else if (mode === 'emit') {
    await bus.emitOrThrow({
      id: arg,
      timestamp: new Date().toISOString(),
      appId: 'app_p7',
      tenantId: 'ten_p7',
      category: 'payment',
      providerId: 'stripe',
      status: 'success',
      latency: 1,
      cost: 0,
      decisionReason: 'phase7-01-probe',
      payload: {},
      response: null,
    });
    process.stdout.write(`${JSON.stringify({ pid: process.pid, emitted: arg })}\n`);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
