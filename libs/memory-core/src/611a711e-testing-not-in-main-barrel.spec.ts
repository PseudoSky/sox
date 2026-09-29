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
 *
 * SECOND ROUND (still open on 1e23fc05, the first BL-611a711e fix commit — a blocking review
 * finding, not a hypothetical): that commit widened the main barrel to also export
 * `DETERMINISTIC_TEST_PROVIDER_MODEL_ID` from `./embed-test-provider.js`, AND kept the
 * package.json surface shipping the test-only helper anyway — `files` still listed
 * `dist-testing`, and `exports["./testing"]` / `typesVersions` still mapped a PUBLIC `./testing`
 * subpath onto it. A published npm tarball would have carried the whole test-only build. The two
 * `it.each` blocks below close both: the source-level main-barrel check (extended to cover the
 * new symbol) and a package.json-level check that the published surface never references
 * `dist-testing` or a `./testing` subpath at all — this package's `/testing` entry is reachable
 * in-repo only (tsconfig.base.json `paths` + vitest `resolve.alias` in every consuming suite),
 * never through `package.json`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mainBarrel from './index.js';

const PACKAGE_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

describe('BL-611a711e — embed-isolation test helper is not part of the main memory-core barrel', () => {
  it.each(['isInside', 'operatorEmbedRoots', 'embedIsolationViolations', 'assertEmbedPathsIsolated', 'DETERMINISTIC_TEST_PROVIDER_MODEL_ID'])(
    '%s is NOT exported from ./index.js',
    (name) => {
      expect(
        Object.prototype.hasOwnProperty.call(mainBarrel, name),
        `main barrel must not export test-only symbol "${name}" (BL-611a711e)`,
      ).toBe(false);
    },
  );
});

describe('BL-611a711e — the published npm surface (package.json) never exposes the test-only /testing subpath', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    files?: unknown[];
    exports?: Record<string, unknown>;
    typesVersions?: unknown;
  };

  it('package.json "files" does not list dist-testing', () => {
    expect(
      (pkg.files ?? []).some((f) => String(f).includes('dist-testing')),
      `package.json "files" must not reference dist-testing (BL-611a711e): ${JSON.stringify(pkg.files)}`,
    ).toBe(false);
  });

  it('package.json "exports" has no "./testing" entry', () => {
    expect(
      Object.prototype.hasOwnProperty.call(pkg.exports ?? {}, './testing'),
      `package.json "exports" must not carry a "./testing" subpath (BL-611a711e): ${JSON.stringify(pkg.exports)}`,
    ).toBe(false);
  });

  it('package.json has no "typesVersions" block referencing testing/dist-testing', () => {
    expect(
      pkg.typesVersions === undefined,
      `package.json must not carry a "typesVersions" block (BL-611a711e, it only ever mapped the removed ./testing subpath): ${JSON.stringify(pkg.typesVersions)}`,
    ).toBe(true);
  });
});
