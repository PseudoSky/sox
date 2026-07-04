import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(__dirname, '../../../../..');

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
      '@adhd/sox-service-proxy': resolve(repoRoot, 'libs/service-proxy/dist/index.js'),
    },
  },
  test: {
    include: [
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/**/*.spec.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/**/*.test.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/*.test.ts',
    ],
    environment: 'node',
    root: repoRoot,
    // First embed() call loads the fastembed ONNX model (bge-base-en-v1.5) into
    // the worker; warmup can take several seconds. Match memory-core's 30s budget
    // so model-load-on-first-embed does not trip the default 5s test timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
