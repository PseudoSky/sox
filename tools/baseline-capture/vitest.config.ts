import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Same alias memory-core's own vitest.config.ts uses (BL-161 follow-up):
      // bypass the ESM-only exports-map resolution failure while keeping the
      // FastembedProvider's __dirname-based sibling-worker resolution valid.
      '@adhd/sox-embedding-provider': resolve(
        __dirname,
        '../../libs/data/embed/embedding-provider/dist/index.js',
      ),
      '@adhd/sox-memory-core': resolve(__dirname, '../../libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
