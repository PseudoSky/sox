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
    // Pins the pre-existing suite to the SOX_SYNC_EMBED=1 kill-switch path so
    // vector-dependent assertions never race the async Phase-B pipeline; the
    // async default is covered deterministically by async-embed.spec.ts.
    setupFiles: [
      resolve(
        repoRoot,
        'extensions/bundles/sox-memory-bundle/members/memory-server/vitest.setup.ts',
      ),
    ],
    // First embed() call loads the fastembed ONNX model (bge-base-en-v1.5) into
    // the worker; warmup can take several seconds. Match memory-core's 30s budget
    // so model-load-on-first-embed does not trip the default 5s test timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // BL-171: recall-sqlite.test.ts's 'real embedding semantic proof' describe
    // (and in fact every describe in that file — both the 'auto' and 'real'
    // SOX_EMBED_BACKEND values resolve to the same real fastembed/ONNX backend;
    // see libs/memory-core/src/embed.ts resolveProvider(), "always uses the real
    // fastembed backend... no degraded fallback") loads onnxruntime-node's native
    // V8 HandleScope machinery. Running multiple spec files as concurrent forked
    // workers risks the same native-addon crash class memory-core pinned around
    // (libs/memory-core/vitest.config.ts). Decision: PIN the pool rather than
    // split into a separate CI target — this keeps the "real embedding proof"
    // test exercising the actual real backend (not stubbed), while eliminating
    // the concurrency hazard by serialising all memory-server spec files into a
    // single forked worker, matching memory-core's proven pattern exactly.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
