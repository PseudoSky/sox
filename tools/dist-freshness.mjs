/**
 * dist-freshness — detect a `dist/` build artifact that is OLDER than the `src/` it was
 * built from, for any package a test run loads through a dist alias.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tools/check-suite-tree-state.mjs` [BL-456] answers "was the SOURCE clean when this suite
 * ran?" by reading `git status`. That is only half of attributability, and the missing half
 * cost a full P0 investigation on 2026-09-22:
 *
 *   `extensions/bundles/sox-memory-bundle/members/memory-server/vitest.config.ts` aliases
 *   `@adhd/sox-memory-core` to `libs/memory-core/dist/index.js` — the BUILT ARTIFACT, not the
 *   source. `dist/` is gitignored, so `git status` cannot see it, and the tree-state report
 *   printed `CLEAN` while the suite was loading a six-hour-old build.
 *
 *   Concretely: an agent in the worktree `agent-a8327434231d7047d` ran
 *   `recall-degradation-visibility.spec.ts` and got `2 failed | 2 passed`. AC-1 and AC-2 failed
 *   on `expected undefined to be defined` / `expected +0 to be 2`. Both ACs exercise
 *   `memoryRecall`'s EMPTY-CORPUS return branch. That worktree's `libs/memory-core/dist/recall.js`
 *   was built at 15:28 and did not contain the empty-corpus `if (degradations.length > 0)
 *   response.degradations = degradations;` block, which landed in source at 21:21:30 (31888bcc).
 *   AC-3 (clean recall) and AC-4 (populated corpus, different return path) passed — so the
 *   failure pattern read exactly like a partial code defect, and was reported up the chain as
 *   "main is red and shipped that way". Main was not red. The artifact was old.
 *
 * The same hazard runs in the other, silent direction: a suite can go GREEN against a `dist/`
 * that predates the fix it is supposed to certify. At the moment this module was written,
 * `libs/memory-core/dist/recall.js:501` still read `provider_call_count: 0` while HEAD's
 * `libs/memory-core/src/recall.ts` read `getProviderCallCount() - beforeCount` (85844493) — the
 * memory-server suite was green against an artifact that did not match committed source.
 *
 * A stale `dist/` does not make a suite result wrong. It makes it UNATTRIBUTABLE — the same
 * standard BL-456 already applies to a dirty source tree. This module makes it visible.
 *
 * WHAT IT DOES
 * ------------
 * For a package directory, finds the newest mtime under `src/` and the newest mtime under
 * `dist/`, and reports the package as stale when source is newer (or when `dist/` is missing
 * entirely while `src/` exists). mtime, not content hashing: every builder in this repo
 * (`tsc`, `tools/bundle-extension.cjs`) writes its outputs after reading its inputs, so
 * `newest(src) > newest(dist)` is a sound one-directional signal — it can only fire when
 * something in `src/` was written after the last build. It deliberately does NOT try to prove
 * freshness (a build whose output happens to be newer may still have been a cache replay); it
 * proves STALENESS, which is the failure mode that burns people.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Directory names never worth walking — never inputs to, nor outputs of, a build. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.nx', '__pycache__', 'coverage', '.turbo']);

/**
 * Files under `src/` that are NOT build inputs, and whose mtime must therefore not be read as
 * evidence that `dist/` is behind.
 *
 * Specs live beside the code they exercise in this repo, and every bundler here emits from an
 * entry point — `tools/bundle-extension.cjs` from `src/index.ts`, `tsc` under a `rootDir` that
 * includes specs but whose output nothing loads. Counting them produced an immediate false
 * positive on first run: `libs/data/store/store-adapter` reported a 3-hour lag sourced entirely
 * from `turso-fts-quoted-query.bug-quote-escape.test.ts`, and this module's OWN new spec file
 * flagged memory-server against itself. A guard that fires on writing a test is a guard that
 * gets ignored, and being ignored is the exact failure mode it exists to correct.
 */
const NON_BUILD_INPUT = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * Newest mtime (epoch ms) of any file under `dir`, and the file that carries it.
 * Returns `null` when `dir` does not exist or contains no files.
 *
 * @param {string} dir
 * @param {{ skipPattern?: RegExp }} [opts] files matching `skipPattern` do not participate
 * @returns {{ mtimeMs: number, file: string } | null}
 */
export function newestFileUnder(dir, opts = {}) {
  const { skipPattern } = opts;
  /** @type {{ mtimeMs: number, file: string } | null} */
  let newest = null;
  /** @param {string} d */
  const walk = (d) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable or absent — nothing to report from here
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (skipPattern && skipPattern.test(entry.name)) continue;
      try {
        const { mtimeMs } = statSync(full);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { mtimeMs, file: full };
      } catch {
        // A file that vanished mid-walk (another agent's build) simply does not
        // participate in the maximum; it cannot make a fresh dist look stale.
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Staleness verdict for a single package directory.
 *
 * @param {string} pkgDir absolute path to the package root (the dir containing `src/` and `dist/`)
 * @param {{ srcSubdir?: string, distSubdir?: string, name?: string }} [opts]
 * @returns {{
 *   name: string, pkgDir: string, stale: boolean, reason: string | null,
 *   newestSrc: { mtimeMs: number, file: string } | null,
 *   newestDist: { mtimeMs: number, file: string } | null,
 *   lagMs: number | null,
 * }}
 */
export function inspectPackage(pkgDir, opts = {}) {
  const name = opts.name ?? path.basename(pkgDir);
  const newestSrc = newestFileUnder(path.join(pkgDir, opts.srcSubdir ?? 'src'), {
    skipPattern: NON_BUILD_INPUT,
  });
  // The SAME exclusion applies to dist/, and the asymmetry would be a silent false NEGATIVE:
  // several builds here compile `src/**/*.ts` wholesale, specs included, so a freshly-written
  // spec emits a fresh `thing.spec.js` into dist/. That bumps `newest(dist)` while
  // `newest(src)` correctly ignores the spec source — masking a genuinely stale production
  // file for exactly as long as someone is actively editing tests, which is precisely when
  // they are also editing code.
  const newestDist = newestFileUnder(path.join(pkgDir, opts.distSubdir ?? 'dist'), {
    skipPattern: NON_BUILD_INPUT,
  });

  // No src/ at all: nothing is being built from here, so nothing can be stale.
  if (!newestSrc) {
    return { name, pkgDir, stale: false, reason: null, newestSrc, newestDist, lagMs: null };
  }
  if (!newestDist) {
    // Only a defect for packages that are LOADED through a dist alias; callers that pass a
    // package with no dist/ by choice (source-resolved) filter this out themselves.
    return {
      name,
      pkgDir,
      stale: true,
      reason: 'dist/ is missing entirely while src/ exists',
      newestSrc,
      newestDist,
      lagMs: null,
    };
  }
  const lagMs = newestSrc.mtimeMs - newestDist.mtimeMs;
  if (lagMs <= 0) {
    return { name, pkgDir, stale: false, reason: null, newestSrc, newestDist, lagMs };
  }
  return {
    name,
    pkgDir,
    stale: true,
    reason:
      `src/ is ${Math.round(lagMs / 1000)}s newer than dist/ ` +
      `(${path.basename(newestSrc.file)} @ ${new Date(newestSrc.mtimeMs).toISOString()} > ` +
      `${path.basename(newestDist.file)} @ ${new Date(newestDist.mtimeMs).toISOString()})`,
    newestSrc,
    newestDist,
    lagMs,
  };
}

/**
 * Inspect several package dirs; return only the stale ones, newest-lag first.
 *
 * @param {Array<{ pkgDir: string, name?: string, srcSubdir?: string, distSubdir?: string }>} pkgs
 * @returns {ReturnType<typeof inspectPackage>[]}
 */
export function staleDistArtifacts(pkgs) {
  return pkgs
    .map(({ pkgDir, ...opts }) => inspectPackage(pkgDir, opts))
    .filter((r) => r.stale)
    .sort((a, b) => (b.lagMs ?? Infinity) - (a.lagMs ?? Infinity));
}

/**
 * Human-readable multi-line report for a set of stale verdicts. Empty string when nothing is
 * stale, so callers can `if (msg) console.error(msg)`.
 *
 * @param {ReturnType<typeof inspectPackage>[]} stale
 * @param {{ context?: string }} [opts]
 * @returns {string}
 */
export function formatStaleReport(stale, opts = {}) {
  if (stale.length === 0) return '';
  const lines = [
    `⛔ STALE dist/ ARTIFACT — ${stale.length} package(s) whose dist/ predates their src/` +
      (opts.context ? ` (${opts.context})` : ''),
    '',
  ];
  for (const s of stale) {
    lines.push(`  ${s.name}: ${s.reason}`);
  }
  lines.push(
    '',
    '  Anything loading these packages through a dist alias is executing code that is NOT the',
    '  source on disk. A suite result measured this way is UNATTRIBUTABLE in both directions:',
    '  it can go RED on a fix that already landed, or GREEN on one that never did.',
    '',
    '  Rebuild before trusting the result:  npx nx build <project>',
    '  (`nx build` deletes dist/ before rebuilding — read the BL-235 constraint in CLAUDE.md first.)',
  );
  return lines.join('\n');
}
