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
    environment: 'node'
  }
});
