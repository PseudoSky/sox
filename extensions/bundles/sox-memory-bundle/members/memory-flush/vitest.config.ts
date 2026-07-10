import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Root is the repo root (4 levels up from this config).
const repoRoot = resolve(__dirname, '../../../../..');

export default defineConfig({
  resolve: {
    alias: {
      // Resolve @adhd/sox-memory-core to the workspace lib dist (same as tsc path alias).
      '@adhd/sox-memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 30_000,
    // Install the deterministic test embedding provider before any test runs
    // so fireSessionEnd()'s auto-export path never triggers a real ONNX
    // warmup unless explicitly opted in (BL-161). Mirrors memory-core's
    // vitest.setup.ts pattern.
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    // Run all spec files in a single forked worker — prevents per-file ONNX
    // re-loads and eliminates concurrency-driven timeout flake (BL-161).
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
