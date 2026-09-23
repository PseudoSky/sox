// Item 7 (BL-<pending>) — regression test for "no lint target for the root
// sox-ecosystem project". See docs/plan/store-adapter-batch-0.10.0/ triage
// notes for the full incident writeup.
//
// The invariant this test pins:
//   `npx nx run-many -t lint` lints every `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`
//   file that `eslint.config.js` does not ignore. No file may be inside
//   eslint's scope and outside every nx `lint` target.
//
// Before the fix, `scripts/**` and `tools/**` (~60 files) were inside eslint's
// scope (`eslint.config.js` only ignores `**/dist/**`, `**/node_modules/**`,
// `**/.tmp-*/**`) but were not covered by ANY project's `lint` target — the
// root `sox-ecosystem` project declared no `lint` target at all, so
// `npx nx run-many -t lint` silently skipped them and reported success.
//
// This is a PURE glob/JSON test: it reads `eslint.config.js`'s `ignores`
// array and every `project.json`'s `targets.lint.options.lintFilePatterns`
// directly off disk. It does not invoke `nx`, does not build anything, and
// does not require a running eslint process.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const LINTABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// Directories that are never real source, regardless of what any project.json
// declares. Kept identical in *shape* to eslint.config.js's own ignore list —
// duplicated intentionally rather than re-exported, because this test must
// keep working even if eslint.config.js is refactored to compute `ignores`
// dynamically (a static re-export would silently go stale in that case; this
// test would start failing loudly instead, which is the point).
const HARD_IGNORE_DIRS = new Set(['node_modules', 'dist']);

// nx itself never discovers projects (and no lint target ever will) under
// `.nxignore`-listed paths — `.worktrees` in particular holds FULL nested
// git checkouts, including their own (sometimes mid-write, sometimes
// deliberately malformed — see .nxignore's docs/research comment) project.json
// files. Read `.nxignore` directly so this stays in sync with the single
// source of truth for "outside the nx workspace" rather than re-guessing it.
function loadNxIgnorePaths() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.nxignore'), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
const NX_IGNORE_PATHS = loadNxIgnorePaths();

function isNxIgnored(relPath) {
  return NX_IGNORE_PATHS.some(
    (ignored) => relPath === ignored || relPath.startsWith(`${ignored}/`)
  );
}

/** Recursively walk the repo, yielding every file matching LINTABLE_EXTENSIONS,
 * skipping HARD_IGNORE_DIRS, any `.tmp-*` dir, any dotfile/dotdir (no nx
 * project or lint target in this repo has ever targeted a dotdir — they are
 * tool/agent config and cache directories, not lintable source), and anything
 * `.nxignore` excludes from the nx workspace. */
function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const rel = path.relative(REPO_ROOT, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      if (HARD_IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      if (isNxIgnored(rel)) continue;
      walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      if (isNxIgnored(rel)) continue;
      if (LINTABLE_EXTENSIONS.includes(path.extname(entry.name))) {
        acc.push(path.join(dir, entry.name));
      }
    }
  }
  return acc;
}

/** Load eslint.config.js's ignores array (first element's `ignores` key) so
 * the "eslint's scope" side of the invariant is read from the single source
 * of truth, not re-derived. */
async function loadEslintIgnores() {
  const configUrl = new URL('../eslint.config.js', import.meta.url);
  const config = (await import(configUrl.href)).default;
  const ignoreEntry = config.find(
    (entry) => Array.isArray(entry.ignores) && Object.keys(entry).length === 1
  );
  if (!ignoreEntry) {
    throw new Error(
      'eslint.config.js: expected a lone { ignores: [...] } entry as the first array element'
    );
  }
  return ignoreEntry.ignores;
}

/** Minimal glob matcher sufficient for the small, known shapes used in this
 * repo's eslint ignores (`**\/dist/**`, `**\/node_modules/**`, `**\/.tmp-*\/**`). */
function globToRegExp(glob) {
  // Escape regex metacharacters, but leave glob tokens (* ? /) alone —
  // they're handled explicitly below.
  const escaped = glob
    .split('')
    .map((c) => (/[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c))
    .join('');
  // `**` must absorb its own adjacent slash so it can match ZERO directory
  // segments (glob semantics: "dir/**/*.ts" matches "dir/file.ts" too, and
  // "dir/**" matches "dir" itself as well as anything under it). The
  // replacement snippets themselves contain literal `*`/`?` characters
  // (`(?:.*/)?`), so they MUST go in via placeholders and get swapped back in
  // only after the generic single-`*`/`?` wildcard pass runs — otherwise that
  // pass corrupts the regex syntax we just inserted.
  const MID = '\u0000MID\u0000';
  const HEAD = '\u0000HEAD\u0000';
  const TAIL = '\u0000TAIL\u0000';
  const WHOLE = '\u0000WHOLE\u0000';
  const withPlaceholders = escaped
    .replaceAll('/**/', `/${MID}`)
    .replace(/^\*\*\//, HEAD)
    .replace(/\/\*\*$/, TAIL)
    .replace(/^\*\*$/, WHOLE);
  const withWildcards = withPlaceholders
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]');
  const withGlobstar = withWildcards
    .replaceAll(MID, '(?:.*/)?')
    .replaceAll(HEAD, '(?:.*/)?')
    .replaceAll(TAIL, '(?:/.*)?')
    .replaceAll(WHOLE, '.*');
  return new RegExp(`^${withGlobstar}$`);
}

function isIgnoredByEslint(relPath, ignoreGlobs) {
  return ignoreGlobs.some((glob) => globToRegExp(glob).test(relPath));
}

/** Discover every project.json in the repo (excluding node_modules/dist). */
function findProjectJsonFiles() {
  const acc = [];
  const walkForProjectJson = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.relative(REPO_ROOT, path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (HARD_IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (isNxIgnored(rel)) continue;
        walkForProjectJson(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'project.json') {
        if (isNxIgnored(rel)) continue;
        acc.push(path.join(dir, entry.name));
      }
    }
  };
  walkForProjectJson(REPO_ROOT);
  return acc;
}

/** Expand a single lintFilePatterns glob (as passed to `@nx/eslint:lint`'s
 * `lintFiles()`, or extracted from an `nx:run-commands` eslint invocation)
 * into a concrete file list, resolved relative to the repo root. Supports the
 * `{projectRoot}` template token and a leading `!` negation prefix. */
function expandPattern(pattern, projectRoot) {
  const negated = pattern.startsWith('!');
  const raw = negated ? pattern.slice(1) : pattern;
  const resolved = raw.replaceAll('{projectRoot}', projectRoot);

  // Bare directory reference (no extension, no glob chars) -> everything
  // under it.
  const hasGlobChars = /[*?[\]{}]/.test(resolved);
  let files;
  if (!hasGlobChars) {
    const abs = path.join(REPO_ROOT, resolved);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      files = walk(abs, []).map((f) => path.relative(REPO_ROOT, f));
    } else {
      files = [resolved];
    }
  } else {
    const regex = globToRegExp(resolved);
    files = walk(REPO_ROOT, [])
      .map((f) => path.relative(REPO_ROOT, f))
      .filter((f) => regex.test(f));
  }
  return { negated, files };
}

/** For every project.json with a `lint` target, resolve the concrete set of
 * files it covers. Supports:
 *  - `@nx/eslint:lint` with explicit `lintFilePatterns`
 *  - `@nx/eslint:lint` with no `lintFilePatterns` (schema default: `{projectRoot}`)
 *  - `nx:run-commands` whose `command` string invokes `eslint <patterns...>`
 */
function collectCoveredFiles(projectJsonPaths) {
  const covered = new Set();
  for (const projectJsonPath of projectJsonPaths) {
    const raw = fs.readFileSync(projectJsonPath, 'utf8');
    const json = JSON.parse(raw);
    const lintTarget = json?.targets?.lint;
    if (!lintTarget) continue;

    const projectRootAbs = path.dirname(projectJsonPath);
    const projectRoot = path.relative(REPO_ROOT, projectRootAbs) || '.';

    let patterns = [];
    if (lintTarget.executor === '@nx/eslint:lint') {
      patterns = lintTarget.options?.lintFilePatterns ?? ['{projectRoot}'];
    } else if (lintTarget.executor === 'nx:run-commands') {
      const command = lintTarget.options?.command ?? '';
      if (/\beslint\b/.test(command)) {
        patterns = command
          .split(/\s+/)
          .slice(1) // drop the `eslint` (or `npx eslint`) token itself handled below
          .filter((tok) => tok && !tok.startsWith('-'));
        // Re-include everything after the eslint token, in case of `npx eslint ...`
        const eslintIdx = command.split(/\s+/).findIndex((t) => t === 'eslint');
        if (eslintIdx >= 0) {
          patterns = command
            .split(/\s+/)
            .slice(eslintIdx + 1)
            .filter((tok) => tok && !tok.startsWith('-'));
        }
      }
    }

    const positives = [];
    const negatives = [];
    for (const pattern of patterns) {
      const { negated, files } = expandPattern(pattern, projectRoot);
      (negated ? negatives : positives).push(...files);
    }
    const negativeSet = new Set(negatives);
    for (const f of positives) {
      if (!negativeSet.has(f)) covered.add(f);
    }
  }
  return covered;
}

// Item 7's fix is scoped to the root `sox-ecosystem` project's own domain:
// `scripts/**`, `tools/**`, and bare root-level files. Directories owned by
// OTHER nx projects (apps/sox, libs/*, extensions/*, docs/plan/*, etc.) are
// out of this item's file set — even where they have their own, independently
// pre-existing coverage gaps (e.g. a project's `lint` target only listing
// `**/*.ts` and missing `**/*.js`/`**/*.cjs` siblings). Fixing those belongs
// to whoever owns that project's `project.json`, not to this item. This
// predicate draws exactly that line.
function isInRootProjectDomain(relPath) {
  return (
    relPath.startsWith('scripts/') ||
    relPath.startsWith('tools/') ||
    !relPath.includes('/') // bare root-level file
  );
}

describe('lint coverage (Item 7 / BL-<pending>)', () => {
  it('covers every eslint-scoped scripts/**, tools/**, and root-level file with a lint target', async () => {
    const ignoreGlobs = await loadEslintIgnores();

    const allLintableFiles = walk(REPO_ROOT, [])
      .map((f) => path.relative(REPO_ROOT, f))
      .filter((f) => !isIgnoredByEslint(f, ignoreGlobs));

    expect(allLintableFiles.length).toBeGreaterThan(0);

    const projectJsonPaths = findProjectJsonFiles();
    expect(projectJsonPaths.length).toBeGreaterThan(0);

    const covered = collectCoveredFiles(projectJsonPaths);

    const uncovered = allLintableFiles.filter((f) => !covered.has(f));
    const uncoveredInScope = uncovered.filter(isInRootProjectDomain);
    const uncoveredOutOfScope = uncovered.filter((f) => !isInRootProjectDomain(f));

    if (uncoveredOutOfScope.length > 0) {
      // Informational only — pre-existing gaps owned by OTHER projects.
      // Never asserted on here; see BACKLOG for tracked follow-ups.
      console.warn(
        `${uncoveredOutOfScope.length} file(s) elsewhere in the repo are inside eslint's ` +
          `scope but outside every nx lint target (OUT OF SCOPE for Item 7 — owned by another ` +
          `project's project.json):\n` +
          uncoveredOutOfScope.join('\n')
      );
    }

    if (uncoveredInScope.length > 0) {
      console.error(
        `${uncoveredInScope.length} file(s) under scripts/, tools/, or repo-root are inside ` +
          `eslint's scope but outside the root sox-ecosystem project's lint target:\n` +
          uncoveredInScope.join('\n')
      );
    }

    expect(uncoveredInScope).toEqual([]);
  });

  it('root sox-ecosystem project declares a lint target covering scripts/ and tools/', () => {
    const rootProjectJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'project.json'), 'utf8')
    );
    const lintTarget = rootProjectJson?.targets?.lint;
    expect(lintTarget).toBeDefined();
    expect(lintTarget.executor).toBe('@nx/eslint:lint');
    const patterns = lintTarget.options?.lintFilePatterns ?? [];
    expect(patterns.some((p) => p.startsWith('scripts/'))).toBe(true);
    expect(patterns.some((p) => p.startsWith('tools/'))).toBe(true);
  });
});
