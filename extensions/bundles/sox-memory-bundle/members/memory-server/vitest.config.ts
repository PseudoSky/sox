import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(__dirname, '../../../../..');
const SPEC_DIR = 'extensions/bundles/sox-memory-bundle/members/memory-server';

export default defineConfig({
  resolve: {
    alias: {
      // BL-611a711e: `@adhd/sox-memory-core/testing` is an IN-REPO-ONLY subpath — the package's
      // `package.json` carries no `exports["./testing"]` entry and does not ship `dist-testing/`
      // (it is not part of the published npm surface), so this alias is the ONLY way this suite
      // resolves it at runtime (tsconfig.base.json's `paths` entry covers typecheck only, not
      // vitest's module resolution). The MORE SPECIFIC alias MUST come first: vite's aliasing
      // (rollup's `@rollup/plugin-alias` semantics) matches in insertion order and returns the
      // FIRST entry whose key matches, not the longest key — swapping this order would make
      // `@adhd/sox-memory-core/testing` imports match the plain `@adhd/sox-memory-core` alias
      // instead and resolve to the wrong file.
      '@adhd/sox-memory-core/testing': resolve(repoRoot, 'libs/memory-core/dist-testing/testing/index.js'),
      '@adhd/sox-memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
      '@adhd/sox-service-proxy': resolve(repoRoot, 'libs/service-proxy/dist/index.js'),
    },
  },
  test: {
    // Pins the pre-existing suite to the SOX_SYNC_EMBED=1 kill-switch path so
    // vector-dependent assertions never race the async Phase-B pipeline; the
    // async default is covered deterministically by async-embed.spec.ts. The
    // setup ALSO installs the BL-567 deterministic mock provider by default.
    setupFiles: [
      resolve(repoRoot, `${SPEC_DIR}/vitest.setup.ts`),
    ],
    // Run-scoped, once, in the runner process — NOT per worker. It reports whether the two
    // `resolve.alias` entries above point at a dist/ that is older than its src/. Those aliases
    // mean this suite executes BUILT ARTIFACTS, and dist/ is gitignored, so neither `git status`
    // nor `tools/check-suite-tree-state.mjs` could see a stale one; on 2026-09-22 a six-hour-old
    // memory-core build turned into a reported "main is red and shipped that way" P0 against a
    // green main. See vitest.global-setup.ts for the full incident.
    //
    // BL-26291f21: the second entry mints ONE run-scoped embed scratch root (model cache cloned
    // from the operator's, read-only; embed-host socket dir) and pins SOX_EMBED_CACHE_DIR /
    // XDG_CACHE_HOME / SOX_ECOSYSTEM_HOME into the env every fork worker inherits, so no worker —
    // in particular the in-process 'real-backend' project — can resolve the operator's
    // ~/.cache/sox/models or ~/.adhd/sox-ecosystem. Its teardown reaps the run's embed hosts.
    globalSetup: [
      resolve(repoRoot, `${SPEC_DIR}/vitest.global-setup.ts`),
      resolve(repoRoot, `${SPEC_DIR}/vitest.global-embed-scratch.ts`),
    ],
    environment: 'node',
    root: repoRoot,
    // BL-7e5be7e8: permanent decoy operator store config, injected into every worker BEFORE
    // setupFiles run. vitest.setup.ts must scrub it (scrubOperatorStoreEnv), so the
    // bl-7e5be7e8 wiring spec goes red on EVERY run if that call is ever removed — not only
    // when someone happens to export the variables. Paths are unreachable and outside any
    // ~/.memory allowlist, so an unscrubbed decoy can never resolve a real store.
    env: {
      SOX_CONFIG_DB_PATH: '/nonexistent/bl-7e5be7e8-decoy/memory.db',
      SOX_AUTO_BACKUP_DIR: '/nonexistent/bl-7e5be7e8-decoy/backups',
    },
    // BL-567: both projects keep the 30s budgets. The 'real-backend' project
    // genuinely needs them — first embed() loads the fastembed ONNX model
    // (bge-base-en-v1.5), warmup takes several seconds even from cache. The
    // 'default-mock' project never loads native code (embeds are ~0ms feature
    // hashing), so the budget is pure headroom there — tests finish fast
    // regardless, and per-test overrides (e.g. bug-memory-001's 60s,
    // throughput-golden's 45s hooks) carry the genuinely slow arms.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // BL-567 project split: the suite is no longer one serialized pool.
    //
    // BEFORE: every memory-server worker could load real ONNX (only 10 of 26
    // spec files injected DeterministicTestProvider), so BL-171 pinned the
    // whole suite to pool:'forks' + maxWorkers:1 — every test file ran in its
    // own freshly-forked worker, and every worker that embedded paid the real
    // model load (~8+ ONNX loads visible per run).
    //
    // AFTER: the setup mock makes the default suite native-free, so it runs in
    // PARALLEL forked workers (no maxWorkers cap). The native-addon pin moves
    // to the 'real-backend' project, which contains exactly the files that
    // opt out of the mock and genuinely load real ONNX: recall-sqlite.test.ts
    // ('real embedding semantic proof' describe), turso-clean-room.test.ts
    // ('real embedding throughput' test), clustering-e2e.test.ts (whole file,
    // measured real-BGE clustering threshold). Each of those files gates
    // itself (skip, not fail) on the ONNX model cache being present.
    projects: [
      {
        extends: true,
        test: {
          name: 'default-mock',
          include: [
            `${SPEC_DIR}/src/**/*.spec.ts`,
            `${SPEC_DIR}/src/**/*.test.ts`,
            `${SPEC_DIR}/*.test.ts`,
            // Named real-backend exceptions — they live in the 'real-backend'
            // project below, which keeps the serialisation pin where real ONNX
            // actually loads.
            `!${SPEC_DIR}/recall-sqlite.test.ts`,
            `!${SPEC_DIR}/turso-clean-room.test.ts`,
            `!${SPEC_DIR}/clustering-e2e.test.ts`,
          ],
          // BL-567: no file in this project loads onnxruntime-node (the setup
          // mock short-circuits getOrCreateProvider() before any fastembed
          // child is spawned), so parallel forked workers are safe. This is
          // the serialization the mock default lifts.
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          name: 'real-backend',
          include: [
            `${SPEC_DIR}/recall-sqlite.test.ts`,
            `${SPEC_DIR}/turso-clean-room.test.ts`,
            `${SPEC_DIR}/clustering-e2e.test.ts`,
          ],
          // BL-171/BL-161: these files load the real fastembed/ONNX model
          // (onnxruntime-node's native V8 HandleScope machinery). Keep the
          // proven serialisation pin exactly where real ONNX loads; each file
          // opts out of the setup mock itself and skips when the model cache
          // is absent, so on a cache-less machine this project runs zero
          // native code.
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
    ],
  },
});
