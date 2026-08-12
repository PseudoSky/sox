import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-manifest': resolve(__dirname, 'libs/manifest/dist/index.js'),
      '@adhd/sox-authoring': resolve(__dirname, 'libs/authoring/dist/index.js'),
      '@adhd/sox-install-engine': resolve(__dirname, 'libs/install-engine/dist/index.js'),
      '@adhd/sox-host-runtime': resolve(__dirname, 'libs/host-runtime/dist/index.js'),
      '@adhd/sox-registry': resolve(__dirname, 'libs/registry/dist/index.js'),
      '@adhd/sox-memory-core': resolve(__dirname, 'libs/memory-core/dist/index.js'),
      // BL-404 universal-coverage: the telemetry setup hook (setupFiles below)
      // imports @adhd/sox-telemetry; the root package.json does NOT declare it,
      // so pnpm's isolated linker has no node_modules symlink for it here —
      // alias it to the built dist exactly like the other @adhd/* aliases.
      '@adhd/sox-telemetry': resolve(__dirname, 'libs/observability/sox-telemetry/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/**/*.test.ts', 'scripts/**/*.test.{ts,mjs}'],
    // D1 (2026-08-06): every *.test.ts file under extensions/** lives inside
    // memory-server (verified empirically — `find extensions -name '*.test.ts'`
    // returns zero matches outside this one package). memory-server owns its
    // OWN project-scoped vitest.config.ts (`nx test memory-server`), which
    // loads its `vitest.setup.ts` (SOX_SYNC_EMBED=1 + STORE_ADAPTER=sqlite pin,
    // the BL-412 live-store guard, pool:'forks'/maxWorkers:1 for onnxruntime
    // native-addon safety) — none of which this root aggregate config provides.
    // Before this exclude, `npx nx test sox-ecosystem` (and any `nx run-many -t
    // test` sweep) re-ran these exact files a SECOND time, unconfigured: no
    // SOX_SYNC_EMBED pin meant every `memory_write` took the async default
    // Phase-B path, so `turso-clean-room.test.ts`'s and `clustering-e2e.test.ts`'s
    // synchronous-looking `vec_node` assertions raced the fire-and-forget
    // embed pipeline and read `vec_node` before Phase B (or even the debounced
    // wakeDrain-triggered heal pass) had a chance to land a single row — the
    // observed "0 to be greater than 0" failure. Worse, `WriteQueue.
    // clearInstances()` (afterAll) closes the adapter unconditionally, without
    // draining that still-in-flight fire-and-forget work, so when Phase-B/heal
    // finally did run, it hit "database connection is not open" (E_IO) against
    // the now-closed adapter — the stderr flood this defect was originally
    // reported by. The files were never broken; the SECOND, misconfigured
    // runner was. Excluding them here leaves memory-server's own `nx test
    // memory-server` as the SOLE (correctly configured) runner.
    exclude: [
      ...configDefaults.exclude,
      'extensions/bundles/sox-memory-bundle/members/memory-server/**',
    ],
    globals: false,
    // BL-179: redirect SOX_ECOSYSTEM_HOME to a per-run mkdtemp scratch dir before
    // any test runs, so in-process install() calls and spawned soxe processes never
    // write to the real ~/.adhd/sox-ecosystem/ user data root.
    globalSetup: ['scripts/test-env-setup.ts'],
    // BL-404 universal-coverage: per-WORKER telemetry composition root — must live
    // in setupFiles, not globalSetup, because initTelemetry is per-process state
    // and globalSetup does not compose the workers that run the tests. The hook
    // omits logDir, so the runtime default resolves it under the ecosystem home
    // (SOX_ECOSYSTEM_HOME → the BL-179 scratch home in sandboxed runs, else
    // ~/.adhd/sox-ecosystem/sox-tests/logs) — captured, never dropped behind
    // the logSink:'none' fallback, never a bare tmpdir.
    setupFiles: ['scripts/telemetry-test-setup.ts'],
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
