import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-manifest': resolve(__dirname, 'libs/manifest/dist/index.js'),
      '@adhd/sox-authoring': resolve(__dirname, 'libs/authoring/dist/index.js'),
      '@adhd/sox-install-engine': resolve(__dirname, 'libs/install-engine/dist/index.js'),
      '@adhd/sox-host-runtime': resolve(__dirname, 'libs/host-runtime/dist/index.js'),
      '@adhd/sox-registry': resolve(__dirname, 'libs/registry/dist/index.js'),
      '@adhd/sox-memory-core': resolve(__dirname, 'libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
    // BL-179: redirect SOX_ECOSYSTEM_HOME to a per-run mkdtemp scratch dir before
    // any test runs, so in-process install() calls and spawned soxe processes never
    // write to the real ~/.adhd/sox-ecosystem/ user data root.
    globalSetup: ['scripts/test-env-setup.ts'],
    // First embed() call loads the fastembed ONNX model (bge-base-en-v1.5) into a
    // worker thread; warmup can take several seconds. This root aggregate config
    // double-covers extensions/**/*.test.ts files (e.g. memory-server's
    // recall-sqlite.test.ts) that already set testTimeout/hookTimeout: 30_000 in
    // their own project-local vitest.config.ts for exactly this reason — match it
    // here so the same files don't trip the default 5s timeout under this runner.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
