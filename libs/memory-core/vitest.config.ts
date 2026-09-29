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
    // BL-7e5be7e8: permanent decoy operator store config, injected into every worker BEFORE
    // setupFiles run. vitest.setup.ts must scrub it (scrubOperatorStoreEnv), so the
    // bl-7e5be7e8 wiring spec goes red on EVERY run if that call is ever removed — not only
    // when someone happens to export the variables. Paths are unreachable and outside any
    // ~/.memory allowlist, so an unscrubbed decoy can never resolve a real store.
    env: {
      SOX_CONFIG_DB_PATH: '/nonexistent/bl-7e5be7e8-decoy/memory.db',
      SOX_AUTO_BACKUP_DIR: '/nonexistent/bl-7e5be7e8-decoy/backups',
    },
    testTimeout: 30_000,
    // BL-bae70da4: globalSetup runs in its own process, outside every forked
    // worker, before any worker starts and after all have exited — it never
    // sees the per-worker HOME redirect below, so it can snapshot the real
    // operator ~/.memory from an unaffected vantage point. See
    // vitest.global-guard.ts for the full rationale.
    globalSetup: [resolve(__dirname, 'vitest.global-guard.ts')],
    // Order matters: the HOME redirect MUST run before anything else
    // (including vitest.setup.ts, which calls initTelemetry) so no
    // ~/.memory-shaped path is resolved against the operator's real home at
    // any point in this worker. The fs-touch guard is installed next so it
    // is armed before the first spec module (which may call os.homedir()
    // at import time in a future edit) ever loads. See
    // vitest.home-scratch-setup.ts / vitest.home-guard-setup.ts.
    setupFiles: [
      resolve(__dirname, 'vitest.home-scratch-setup.ts'),
      resolve(__dirname, 'vitest.home-guard-setup.ts'),
      resolve(__dirname, 'vitest.setup.ts'),
    ],
    // Run all spec files in a single forked worker. This prevents per-file ONNX
    // re-loads (each fork would re-initialise the model) and eliminates the
    // concurrency-driven timeout flake (BL-161).
    // Vitest 4: singleFork → maxWorkers: 1 (poolOptions was removed in v4).
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
