import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * e2e lane (real child processes against the built dist). Collected here and
 * excluded from the unit config; run with `npx nx run sox-telemetry:e2e`.
 */
export default defineConfig({
  test: {
    include: [resolve(__dirname, 'src/**/*.e2e.test.ts')],
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
