/**
 * dist-freshness-guard.spec.ts — 8412f6a8 (test-path half): a `dist/` older than its `src/`
 * must be REPORTED, because this suite executes `dist/` and nothing could see it go stale.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `vitest.config.ts` resolves `@adhd/sox-memory-core` to `libs/memory-core/dist/index.js` and
 * `@adhd/sox-service-proxy` to `libs/service-proxy/dist/index.js`. Every spec in this project
 * therefore runs a BUILT ARTIFACT, not the source on disk. `dist/` is gitignored, so
 * `tools/check-suite-tree-state.mjs` — the tool CLAUDE.md requires you to quote alongside any
 * suite result [BL-456] — reported `CLEAN` while reading only `git status` over source roots.
 * Its report was true and useless: it certified the source while the suite ran the artifact.
 *
 * WHAT IT COST (2026-09-22)
 * -------------------------
 * In worktree `agent-a8327434231d7047d`, `recall-degradation-visibility.spec.ts` returned
 * `2 failed | 2 passed`. AC-1 failed `expected undefined to be defined`; AC-2 failed
 * `expected +0 to be 2`. Both exercise `memoryRecall`'s EMPTY-CORPUS return branch. AC-3 (clean
 * recall) and AC-4 (populated corpus) take other paths and passed — a partial, entirely
 * plausible-looking code defect. It was escalated as "MAIN IS RED AND SHIPPED THAT WAY".
 *
 * Main was green (4/4). That worktree's `libs/memory-core/dist/recall.js` was built at 15:28;
 * the empty-corpus `if (degradations.length > 0) response.degradations = degradations;` line
 * landed in source at 21:21:30 (31888bcc). `diff`ing the two builds shows the block in one and
 * not the other. Hours went into a bug that did not exist, and `CLEAN` was quoted as evidence
 * that it did.
 *
 * The silent direction is worse and was live at the same moment: in the MAIN checkout,
 * `libs/memory-core/dist/recall.js:501` still read `provider_call_count: 0` while HEAD's
 * `src/recall.ts` read `getProviderCallCount() - beforeCount` (85844493). A green suite,
 * measured against an artifact that never contained the fix.
 *
 * WHY THE FIXTURES ARE SYNTHETIC
 * ------------------------------
 * Every case below builds its own package tree under `mkdtempSync` and controls mtimes with
 * `utimesSync`. Asserting against the repo's REAL `libs/memory-core/dist` would make this spec
 * a weather report — green or red depending on who last ran a build, and unfixable from inside
 * a test. Synthetic trees pin the DETECTOR, which is the thing that was missing. AC-5 covers
 * the one real-repo claim that matters and cannot be faked: that the guard's package list is
 * exactly the set of dist aliases the config actually declares. AC-6 pins the one exclusion the
 * detector makes, in both directions.
 *
 * RED→GREEN ACTUALLY PERFORMED, BOTH ARMS (BL-225 — run, not reasoned about):
 *
 *   Arm 1 — the detector. `tools/dist-freshness.mjs`'s `staleDistArtifacts` neutered to
 *   `return []`, i.e. the pre-fix world in which nothing in the repo looked at `dist/` at all:
 *   `Tests  3 failed | 2 passed (5)` — AC-1, AC-3, AC-4 red. AC-2 and AC-5 stayed green, and
 *   that asymmetry is the point: AC-2 asserts the guard STAYS SILENT on a healthy package, so a
 *   detector that reports nothing satisfies it by construction. AC-2 exists to stop the guard
 *   crying wolf, not to detect its absence.
 *
 *   Arm 2 — the coverage list. `@adhd/sox-service-proxy` removed from
 *   `vitest.global-setup.ts`'s `DIST_ALIASED_PACKAGES`, i.e. the "someone added an alias and
 *   never told the guard" blind spot: `Tests  1 failed | 4 passed (5)` — AC-5 red on
 *   `expected [ '@adhd/sox-memory-core' ] to deeply equal [ '@adhd/sox-memory-core', …(1) ]`.
 *   Only AC-5 can see this, which is why it is a separate AC and not folded into AC-1.
 *
 *   Both files restored byte-identical (`diff` verified); all six pass. (AC-6 was added after
 *   those two arms, when the guard's first real run produced the false positives its comment
 *   records; its own red is the pre-exclusion behaviour, reproducible by deleting
 *   `NON_BUILD_INPUT` from `tools/dist-freshness.mjs`.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * Structural mirrors of `tools/dist-freshness.d.mts`'s `IDistFreshnessVerdict`/`IPackageSpec`,
 * declared locally rather than imported. `@nx/enforce-module-boundaries` rejects a relative
 * import that leaves this project ("Projects cannot be imported by a relative or absolute path"),
 * and `tools/` is a bare script directory with no npm scope to import it by. Duplicating two
 * small shapes is the proportionate answer; AC-1/AC-3 assert every field named here against the
 * real module's output, so a drift in the real type surfaces as a failing assertion, not as a
 * silently-satisfied `any`.
 */
interface IDistFreshnessVerdict {
  name: string;
  pkgDir: string;
  stale: boolean;
  reason: string | null;
  newestSrc: { mtimeMs: number; file: string } | null;
  newestDist: { mtimeMs: number; file: string } | null;
  lagMs: number | null;
}
interface IPackageSpec {
  pkgDir: string;
  name?: string;
  srcSubdir?: string;
  distSubdir?: string;
}

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
/** The memory-server member root — where vitest.config.ts and vitest.global-setup.ts live. */
const MEMBER_ROOT = path.resolve(__dirname, '..');

/**
 * Loaded dynamically rather than with a static `import`: the module is plain `.mjs` under
 * `tools/`, outside this project's `rootDir`, and dynamic import keeps it out of the CommonJS
 * emit that `tsconfig.json` produces for `src/**` while still type-checking through the
 * hand-written `.d.mts`.
 */
async function loadGuard(): Promise<{
  staleDistArtifacts: (pkgs: IPackageSpec[]) => IDistFreshnessVerdict[];
  formatStaleReport: (stale: IDistFreshnessVerdict[], opts?: { context?: string }) => string;
}> {
  return (await import(
    /* @vite-ignore */ path.join(REPO_ROOT, 'tools/dist-freshness.mjs')
  )) as Awaited<ReturnType<typeof loadGuard>>;
}

const cleanups: Array<() => void> = [];

/**
 * Build a synthetic package with explicit mtimes.
 *
 * @param srcAgeSec  how many seconds BEFORE the reference instant the `src/` file was written
 * @param distAgeSec same, for the `dist/` file; `null` writes no `dist/` at all
 */
function makePackage(name: string, srcAgeSec: number, distAgeSec: number | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sox-distfresh-${name}-`));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  // A fixed reference instant, safely in the past, so neither side can collide with "now"
  // and produce a zero lag that the <= 0 branch would read as fresh.
  const reference = Date.now() - 3_600_000;

  const srcFile = path.join(root, 'src', 'thing.ts');
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, 'export const thing = 1;\n');
  const srcTime = new Date(reference - srcAgeSec * 1000);
  fs.utimesSync(srcFile, srcTime, srcTime);

  if (distAgeSec !== null) {
    const distFile = path.join(root, 'dist', 'thing.js');
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, 'exports.thing = 1;\n');
    const distTime = new Date(reference - distAgeSec * 1000);
    fs.utimesSync(distFile, distTime, distTime);
  }
  return root;
}

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('8412f6a8 — a dist/ older than its src/ is reported, not silently executed', () => {
  it('8412f6a8 AC-1: reports a package whose src/ is newer than its dist/ — the exact 2026-09-22 worktree shape', async () => {
    const { staleDistArtifacts } = await loadGuard();

    // dist built 6 hours before the newest src edit: the measured shape of
    // `.claude/worktrees/agent-a8327434231d7047d` (dist 15:28, src 21:21:30).
    const pkgDir = makePackage('stale', 0, 21_600);

    const stale = staleDistArtifacts([{ pkgDir, name: '@adhd/sox-memory-core' }]);

    // THE CORE CLAIM: pre-fix this list was structurally empty — no tool in the repo looked at
    // dist/ at all, so a six-hour-old artifact reported identically to a fresh one.
    expect(stale).toHaveLength(1);
    const verdict = stale[0]!;
    expect(verdict.name).toBe('@adhd/sox-memory-core');
    expect(verdict.stale).toBe(true);
    // Exact, not `toBeGreaterThan(0)`: the fixture's lag is knowable to the second, and only an
    // exact-ish bound catches a sign flip that would report every FRESH build as stale.
    expect(verdict.lagMs).toBeGreaterThanOrEqual(21_600_000);
    expect(verdict.lagMs).toBeLessThan(21_601_000);
    expect(verdict.reason).toMatch(/newer than dist/);
  });

  it('8412f6a8 AC-2: stays silent when dist/ is newer than src/ — the guard must not cry wolf', async () => {
    const { staleDistArtifacts } = await loadGuard();

    // The healthy ordering: source edited, THEN built.
    const pkgDir = makePackage('fresh', 600, 0);

    // A guard that fired here would be worse than none: agents would learn to ignore it, which
    // is precisely how the original `CLEAN` report stopped being read as a claim about anything.
    expect(staleDistArtifacts([{ pkgDir, name: '@adhd/sox-memory-core' }])).toEqual([]);
  });

  it('8412f6a8 AC-3: reports a MISSING dist/ as stale — a never-built alias resolves to nothing at all', async () => {
    const { staleDistArtifacts } = await loadGuard();

    const pkgDir = makePackage('nodist', 0, null);

    const stale = staleDistArtifacts([{ pkgDir, name: '@adhd/sox-service-proxy' }]);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.reason).toMatch(/dist\/ is missing entirely/);
    // `lagMs` is meaningless with one side absent and must be null, not 0 — 0 would sort this
    // verdict as the least urgent when it is the most.
    expect(stale[0]!.lagMs).toBeNull();
  });

  it('8412f6a8 AC-4: the report names every stale package, and is EMPTY when nothing is stale', async () => {
    const { staleDistArtifacts, formatStaleReport } = await loadGuard();

    const stalePkg = makePackage('report-stale', 0, 900);
    const freshPkg = makePackage('report-fresh', 900, 0);

    const stale = staleDistArtifacts([
      { pkgDir: stalePkg, name: '@adhd/sox-memory-core' },
      { pkgDir: freshPkg, name: '@adhd/sox-service-proxy' },
    ]);
    const text = formatStaleReport(stale, { context: 'unit fixture' });

    expect(text).toContain('@adhd/sox-memory-core');
    // The fresh package must NOT appear: a report that lists everything teaches the reader to
    // skim past the one line that mattered.
    expect(text).not.toContain('@adhd/sox-service-proxy');
    expect(text).toContain('unit fixture');

    // Empty string, not a "nothing stale" pleasantry — callers do `if (msg) console.error(msg)`
    // and a non-empty all-clear would print a scary banner on every healthy run.
    expect(formatStaleReport([])).toBe('');
  });

  it('8412f6a8 AC-6: a newer *.spec.ts does NOT make a package stale — writing a test is not a build input', async () => {
    const { staleDistArtifacts } = await loadGuard();

    // Built AFTER the production source, then a spec is written. dist/ is fully current.
    const pkgDir = makePackage('specs-only', 600, 300);
    const specFile = path.join(pkgDir, 'src', 'thing.spec.ts');
    fs.writeFileSync(specFile, "it('x', () => {});\n"); // mtime = now, far newer than dist/

    // Observed on this guard's very first real run before the exclusion existed:
    // libs/data/store/store-adapter reported a 3-hour lag sourced entirely from a
    // `.test.ts`, and this spec file flagged memory-server against itself. A guard that
    // fires every time someone writes a test is a guard that gets tuned out — which is the
    // exact fate of the `CLEAN` report this whole change exists to make meaningful again.
    expect(staleDistArtifacts([{ pkgDir, name: '@adhd/sox-memory-core' }])).toEqual([]);

    // ...but a newer PRODUCTION file in the same package still fires, so the exclusion cannot
    // be widened into a blanket mute.
    const srcFile = path.join(pkgDir, 'src', 'thing.ts');
    fs.writeFileSync(srcFile, 'export const thing = 2;\n');
    expect(staleDistArtifacts([{ pkgDir, name: '@adhd/sox-memory-core' }])).toHaveLength(1);
  });

  it('8412f6a8 AC-5: the guard covers EXACTLY the dist aliases vitest.config.ts declares', async () => {
    // The one claim about the real repo that no fixture can stand in for. A new
    // `resolve.alias` entry pointing at a dist/ is a new blind spot the moment it is added, and
    // nothing else in the repo would notice; the incident began with an alias nobody had
    // audited. Reading the config text (rather than importing it) keeps this assertion honest
    // even if the config grows conditional logic around its alias map.
    const configText = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'extensions/bundles/sox-memory-bundle/members/memory-server/vitest.config.ts',
      ),
      'utf8',
    );

    const aliasedToDist = [
      ...configText.matchAll(/'(@adhd\/[^']+)':\s*resolve\(repoRoot,\s*'([^']*\/dist\/[^']*)'\)/g),
    ].map((m) => ({ pkg: m[1]!, distEntry: m[2]! }));

    // Sanity: if this ever finds zero, the regex has drifted and AC-5 would pass vacuously —
    // the BL-167 shape. Fail loudly instead.
    expect(aliasedToDist.length).toBeGreaterThanOrEqual(2);

    // Computed specifier, not a literal: `tsconfig.json` sets `rootDir: "src"`, so a static
    // `'../vitest.global-setup.js'` fails `nx typecheck memory-server` with TS6059/TS6307 (the
    // hook lives at the package root, beside vitest.config.ts, where vitest requires it). A
    // runtime-computed path is resolved and transformed by vite-node exactly the same way, and
    // AC-5's assertions fail loudly if it ever stops resolving. No `@vite-ignore` here — this is
    // a TypeScript file and vite must transform it.
    const guardPath = path.join(MEMBER_ROOT, 'vitest.global-setup.ts');
    const guardModule = (await import(guardPath)) as {
      DIST_ALIASED_PACKAGES: Array<{ name: string; pkgDir: string }>;
    };
    const covered = guardModule.DIST_ALIASED_PACKAGES.map((p) => p.name).sort();
    expect(covered).toEqual(aliasedToDist.map((a) => a.pkg).sort());

    // And each covered package dir must be the one the alias actually points into, not a
    // same-named package elsewhere.
    for (const { pkg, distEntry } of aliasedToDist) {
      const entry = guardModule.DIST_ALIASED_PACKAGES.find((p) => p.name === pkg)!;
      expect(path.resolve(REPO_ROOT, distEntry).startsWith(entry.pkgDir + path.sep)).toBe(true);
    }
  });
});
