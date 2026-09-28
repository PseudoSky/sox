import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(__dirname, '../../../../..');
const SPEC_DIR = 'extensions/bundles/sox-memory-bundle/members/memory-cli';

export default defineConfig({
  resolve: {
    alias: {
      // BL-611a711e: `@adhd/sox-memory-core/testing` is an IN-REPO-ONLY subpath — memory-core's
      // `package.json` carries no `exports["./testing"]` entry and does not ship `dist-testing/`
      // (not part of the published npm surface), so this alias is the ONLY way this suite
      // resolves it at runtime (tsconfig.base.json's `paths` entry covers typecheck only).
      // Mirrors memory-server's own `vitest.config.ts` alias pair. The MORE SPECIFIC alias MUST
      // come first: vite's aliasing (rollup's `@rollup/plugin-alias` semantics) matches in
      // insertion order and returns the FIRST entry whose key matches, not the longest key —
      // swapping this order would make `@adhd/sox-memory-core/testing` imports match the plain
      // `@adhd/sox-memory-core` alias instead and resolve to the wrong file.
      '@adhd/sox-memory-core/testing': resolve(repoRoot, 'libs/memory-core/dist-testing/testing/index.js'),
      '@adhd/sox-memory-core': resolve(repoRoot, 'libs/memory-core/dist/index.js'),
    },
  },
  test: {
    include: ['extensions/bundles/sox-memory-bundle/members/memory-cli/src/**/*.spec.ts'],
    environment: 'node',
    root: repoRoot,
    // BL-57ae788f: installs DeterministicTestProvider (no real embed reaches the shared
    // fastembed backend), scrubs the operator's host-injected store config, and asserts embed
    // paths resolve inside this run's scratch root. Mirrors memory-server's vitest.setup.ts.
    setupFiles: [resolve(repoRoot, `${SPEC_DIR}/vitest.setup.ts`)],
    // BL-57ae788f: mints ONE run-scoped embed scratch root before any worker forks and pins
    // SOX_EMBED_CACHE_DIR / XDG_CACHE_HOME / SOX_ECOSYSTEM_HOME into the env every worker
    // inherits; its teardown reaps any embed host this run spawned. Closes the memory-cli half
    // of BL-26291f21 (the `pipeline drain` spec leaked/timed out spawning a real embed host).
    globalSetup: [resolve(repoRoot, `${SPEC_DIR}/vitest.global-embed-scratch.ts`)],
    // BL-57ae788f: permanent decoy operator store config, injected into every worker BEFORE
    // setupFiles run — mirrors memory-server's BL-7e5be7e8 wiring proof. vitest.setup.ts must
    // scrub it (scrubOperatorStoreEnv), so the scrub regression spec goes red on EVERY run if
    // that call is ever removed, not only when someone happens to export the variables. Paths
    // are unreachable and outside any ~/.memory allowlist, so an unscrubbed decoy can never
    // resolve a real store.
    env: {
      SOX_CONFIG_DB_PATH: '/nonexistent/bl-57ae788f-decoy/memory.db',
      SOX_AUTO_BACKUP_DIR: '/nonexistent/bl-57ae788f-decoy/backups',
    },
  },
});
