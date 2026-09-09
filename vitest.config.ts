import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
'@company/shared$': resolve('./packages/shared/src/index.ts'),
      '@company/schemas$': resolve('./packages/schemas/src/index.ts'),
      '@company/events$': resolve('./packages/events/src/index.ts'),
      '@company/database$': resolve('./packages/database/src/index.ts'),
      '@company/providers$': resolve('./packages/providers/src/index.ts'),
      '@company/providers/base$': resolve('./packages/providers/src/base.ts'),
      '@company/api-client$': resolve('./packages/api-client/src/index.ts'),
      '@company/events-sdk$': resolve('./packages/events-sdk/src/index.ts'),
      '@company/routing$': resolve('./packages/routing/src/index.ts'),
      '@company/workers$': resolve('./packages/workers/src/index.ts')
    }
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    // Several suites (packages/simulation/**, plus eventBus/registry/routing
    // tests) exercise real process-wide singletons (EventBus.getInstance(),
    // ProviderRegistry.getInstance(), shared in-memory queues) rather than
    // fresh instances per test. Running test files concurrently lets one
    // file's singleton mutation bleed into another's assertions, producing
    // intermittent cross-file failures unrelated to the code under test.
    // Serializing file execution trades some wall-clock time for a
    // deterministic, non-flaky suite — worth it for a financial platform.
    fileParallelism: false,
  }
});
