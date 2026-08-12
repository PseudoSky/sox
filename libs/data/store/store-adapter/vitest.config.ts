import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The telemetry setup hook lives in scripts/ (outside this package, and
      // the root package.json does not declare @adhd/sox-telemetry, so pnpm's
      // isolated linker has no symlink at the repo root for it) — alias to the
      // built dist exactly like the root vitest.config.ts does.
      '@adhd/sox-telemetry': resolve(
        __dirname,
        '../../../observability/sox-telemetry/dist/index.js',
      ),
    },
  },
  test: {
    root: 'libs/data/store/store-adapter',
    include: ['src/**/*.spec.ts', 'src/**/__tests__/*.test.ts', 'test/**/*.test.ts'],
    // BL-404 universal-coverage: per-worker telemetry composition root (see
    // scripts/telemetry-test-setup.ts). store-adapter's src emitters
    // (retry.ts withRetry, engine-guard, fts-ops, sqlite/turso adapters) run
    // inside these tests; without this hook every record was silently dropped
    // behind the logSink:'none' fallback.
    setupFiles: [resolve(__dirname, '../../../../scripts/telemetry-test-setup.ts')],
    testTimeout: 30000,
  },
});
