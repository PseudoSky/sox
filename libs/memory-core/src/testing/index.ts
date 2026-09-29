/**
 * src/testing/index.ts — the `@adhd/sox-memory-core/testing` subpath barrel (BL-611a711e).
 *
 * A DELIBERATELY SEPARATE entry point from the package's main barrel (`src/index.ts` →
 * `dist/index.js`), built by its own `tsconfig.testing.json` into its own `dist-testing/testing/`
 * output. This subpath is reachable IN-REPO ONLY: a `tsconfig.base.json` `paths` entry (for
 * typecheck) and a `resolve.alias` entry in each consuming suite's vitest config (memory-server,
 * memory-cli) point `@adhd/sox-memory-core/testing` at this build directly — there is no
 * package.json `exports["./testing"]` and `dist-testing/` is not in `files`, so this subpath
 * never ships as part of the published npm package. Cross-package test harnesses (memory-cli)
 * that need `embed-isolation.ts`'s containment checks (or the deterministic provider's
 * `MODEL_ID`) import `@adhd/sox-memory-core/testing`, never `@adhd/sox-memory-core` itself — so a
 * test-only helper never re-enters this package's public npm surface the way it did before this
 * fix (see the header comment on `embed-isolation.ts`).
 *
 * TEST-ONLY. Never imported by production code paths, in this package or any consumer.
 */
export {
  isInside,
  operatorEmbedRoots,
  embedIsolationViolations,
  assertEmbedPathsIsolated,
} from './embed-isolation.js';
// BL-611a711e item 3: MODEL_ID belongs on the test-only subpath, not the main barrel — a spec
// that needs to assert against the deterministic provider's real model id imports it from here.
export { MODEL_ID as DETERMINISTIC_TEST_PROVIDER_MODEL_ID } from '../embed-test-provider.js';
