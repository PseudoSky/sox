/**
 * src/testing/index.ts — the `@adhd/sox-memory-core/testing` subpath barrel (BL-611a711e).
 *
 * A DELIBERATELY SEPARATE entry point from the package's main barrel (`src/index.ts` →
 * `dist/index.js`), built by its own `tsconfig.testing.json` into its own `dist/testing/`
 * output. Cross-package test harnesses (memory-cli) that need `embed-isolation.ts`'s
 * containment checks import `@adhd/sox-memory-core/testing`, never `@adhd/sox-memory-core`
 * itself — so a test-only helper never re-enters this package's public npm surface the way it
 * did before this fix (see the header comment on `embed-isolation.ts`).
 *
 * TEST-ONLY. Never imported by production code paths, in this package or any consumer.
 */
export {
  isInside,
  operatorEmbedRoots,
  embedIsolationViolations,
  assertEmbedPathsIsolated,
} from './embed-isolation.js';
