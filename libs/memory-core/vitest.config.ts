import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    // Map the ESM-only embedding-provider package directly to its built dist
    // entry — this bypasses the "no import/require condition" resolution failure
    // that vite hits on the package's exports map, WHILE keeping the FastembedProvider's
    // `__dirname`-based sibling-worker resolution valid: `dist/embedWorker.js` exists,
    // whereas the src/ tree only has `embedWorker.ts` (aliasing to src broke the real-bge
    // opt-in path — BL-161 follow-up). Matches memory-server's vitest alias.
    alias: {
      '@adhd/sox-embedding-provider': resolve(
        __dirname,
        '../data/embed/embedding-provider/dist/index.js',
      ),
    },
  },
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 30_000,
    // Install the deterministic test provider before any test runs so no spec
    // triggers a real ONNX warmup unless it explicitly opts in.
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    // Run all spec files in a single forked worker. This prevents per-file ONNX
    // re-loads (each fork would re-initialise the model) and eliminates the
    // concurrency-driven timeout flake (BL-161).
    // Vitest 4: singleFork → maxWorkers: 1 (poolOptions was removed in v4).
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
