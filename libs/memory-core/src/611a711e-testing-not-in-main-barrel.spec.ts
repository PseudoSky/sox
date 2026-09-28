/**
 * 611a711e-testing-not-in-main-barrel.spec.ts — regression for backlog 611a711e.
 *
 * WHAT LEAKED: `test-support/embed-isolation.ts` (BL-57ae788f) was re-exported from the package's
 * main barrel (`src/index.ts`), and `src/test-support/**` was not excluded from
 * `tsconfig.lib.json`'s build — unlike `src/testing/**`, which IS excluded. Because `index.ts` (an
 * included root file) imported the module, tsc pulled it into the compiled `dist/index.js` /
 * `dist/index.d.ts` regardless of the exclude list (exclude only controls which files are
 * automatically treated as compilation roots, not whether an imported file is reachable/emitted).
 * Net effect: a TEST-ONLY isolation helper shipped as part of this package's PUBLIC npm surface.
 *
 * THE FIX: the module moved to `src/testing/embed-isolation.ts` (matching the existing
 * `src/testing/legacy-store.ts` convention: excluded from the main build, never imported by
 * `index.ts`) and is no longer re-exported from the main barrel at all. Cross-package consumers
 * (memory-cli) now reach it via the dedicated `@adhd/sox-memory-core/testing` subpath, a SEPARATE
 * build output from the main entry — not via `.` / `dist/index.js`.
 *
 * RED on 7be12c60: `isInside`, `operatorEmbedRoots`, `embedIsolationViolations`,
 * `assertEmbedPathsIsolated` are all present on the `./index.js` (main barrel) module object.
 * GREEN after the fix: none of them are.
 */
import { describe, expect, it } from 'vitest';
import * as mainBarrel from './index.js';

describe('BL-611a711e — embed-isolation test helper is not part of the main memory-core barrel', () => {
  it.each(['isInside', 'operatorEmbedRoots', 'embedIsolationViolations', 'assertEmbedPathsIsolated'])(
    '%s is NOT exported from ./index.js',
    (name) => {
      expect(
        Object.prototype.hasOwnProperty.call(mainBarrel, name),
        `main barrel must not export test-only symbol "${name}" (BL-611a711e)`,
      ).toBe(false);
    },
  );
});
