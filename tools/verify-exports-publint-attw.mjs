#!/usr/bin/env node
/**
 * tools/verify-exports-publint-attw.mjs — BL-266 standardized replacement for
 * tools/verify-package-exports.mjs.
 *
 * verify-package-exports.mjs checked exactly one thing: does every path named
 * in a package.json's main/module/types/bin/exports resolve to a real file?
 * That is a real invariant (BL-208/BL-222 both lived in exactly that gap), but
 * it is also the FLOOR of what a standard tool already does. Proven by a
 * red→green pin (see the BL-266 migration commit) against three field
 * classes — `main`, `exports.<cond>`, and `bin.<name>` — publint's file-
 * existence check is a strict superset:
 *
 *   RED  (main/exports pointed at a nonexistent file): publint exits 1 with
 *        "pkg.exports[...] is ... but the file does not exist." /
 *        "pkg.main is ... but the file does not exist." / same for pkg.bin.
 *   GREEN (paths restored):                            publint exits 0.
 *
 * publint ALSO catches classes verify-package-exports.mjs never checked at
 * all — e.g. a nested dist/package.json declaring an `exports` field Node.js
 * silently ignores outside the package root (a real, pre-existing quirk this
 * script surfaces; see the BL-266 report for the specific packages affected).
 *
 * `@arethetypeswrong/cli` (attw) checks something DIFFERENT and NOT covered
 * by publint or the old script: whether a package's *type* resolution agrees
 * with its *runtime* module format across node10 / node16 (CJS and ESM
 * entry) / bundler resolution algorithms — the exact blind spot BL-208/BL-222
 * lived in. Verified empirically that attw does NOT perform file-existence
 * checking (a nonexistent `main`/`exports` target produced ZERO problems in
 * attw's raw analysis — its `problems` array was empty even in the same RED
 * fixture that made publint fail) — so it is scoped here to `libs/` and
 * `packages/` (real importable/typed packages) and run ALONGSIDE, never
 * INSTEAD OF, publint.
 *
 * attw's default `--profile strict` treats any ESM-only package's inherent
 * "a CJS require() must use a dynamic import" as a hard error — which is by
 * design for every ESM-only public data package in this repo (ADR-0006), not
 * a defect. Packages declaring `"type": "module"` with no dual CJS/ESM build
 * target are run with `--profile esm-only` so that expected characteristic
 * is not reported as a failure; everything else uses `--profile strict`
 * (Are-the-types-wrong's default, matching Node's actual dual-package
 * resolution behavior).
 *
 * Usage:  node tools/verify-exports-publint-attw.mjs [--root <repo>] [--only <dir>]...
 * Exit:   0 = every package clean; 1 = violations (listed, tool-attributed).
 *
 * BL-407: `--only <dir>` (repeatable) restricts the check to that exact set of
 * package directories instead of the whole workspace — used by
 * `scripts/smoke-test.mjs` to scope this preflight to a filtered `--extension`
 * run's actual dependency closure. Omitting `--only` checks everything, same
 * as before; this is additive and never widens scope beyond the full
 * workspace default.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot() {
  const argIdx = process.argv.indexOf('--root');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return path.resolve(process.argv[argIdx + 1]);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }
}

const ROOT = repoRoot();
const BIN = (name) => path.join(ROOT, 'node_modules', '.bin', name);

/** BL-407: repeatable `--only <dir>` — null means "no restriction" (full scope). */
function parseOnlyDirs() {
  const dirs = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--only' && typeof process.argv[i + 1] === 'string') {
      dirs.push(path.resolve(process.argv[i + 1]));
      i++;
    }
  }
  return dirs.length > 0 ? dirs : null;
}
const ONLY_DIRS = parseOnlyDirs();

/** Identical directory-discovery scope to the script this replaces (tools/verify-package-exports.mjs). */
function workspacePackageDirs() {
  const dirs = new Set();
  const pushIfPkg = (d) => {
    if (fs.existsSync(path.join(d, 'package.json'))) dirs.add(d);
  };
  const scanChildren = (base, depth) => {
    if (!fs.existsSync(base)) return;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name === 'dist') continue;
      const full = path.join(base, e.name);
      pushIfPkg(full);
      if (depth > 1) scanChildren(full, depth - 1);
    }
  };
  scanChildren(path.join(ROOT, 'extensions'), 2);
  const bundles = path.join(ROOT, 'extensions', 'bundles');
  if (fs.existsSync(bundles)) {
    for (const b of fs.readdirSync(bundles, { withFileTypes: true })) {
      if (!b.isDirectory()) continue;
      scanChildren(path.join(bundles, b.name, 'members'), 1);
    }
  }
  scanChildren(path.join(ROOT, 'apps'), 3);
  scanChildren(path.join(ROOT, 'libs'), 3);
  scanChildren(path.join(ROOT, 'packages'), 2);
  scanChildren(path.join(ROOT, 'tools'), 1);
  return [...dirs].sort();
}

function hasContractPaths(pkg) {
  if (pkg.main || pkg.module || pkg.types || pkg.exports) return true;
  if (typeof pkg.bin === 'string') return true;
  if (pkg.bin && typeof pkg.bin === 'object' && Object.keys(pkg.bin).length > 0) return true;
  return false;
}

/** attw is scoped to real importable/typed packages — libs/ and packages/, never
 *  extensions/ or apps/ (those ship as single-file bundles require()'d directly
 *  by the host runtime's extension loader; their package.json main/exports
 *  fields exist only for the file-existence contract publint already checks,
 *  not for any external `import` consumer whose type resolution matters). */
function attwInScope(dir) {
  const rel = path.relative(ROOT, dir);
  return rel.startsWith('libs' + path.sep) || rel.startsWith('packages' + path.sep);
}

/**
 * Known-accepted attw findings, scoped per package name, with a stated reason.
 * NOT a blanket escape hatch — each entry names the exact `--ignore-rules`
 * value (from attw's fixed enum) and the specific reason it is a non-issue
 * for THIS package, so a future new violation of a DIFFERENT rule on the same
 * package still fails loudly.
 */
const KNOWN_ACCEPTED_ATTW = {
  // @adhd/sox-nx is `private:true` and consumed ONLY via nx's own CJS executor
  // loader (executors.json → require()), never via an external ESM named
  // import. `export { default as atomicTscExecutor } from '...'` compiles to
  // a getter TS/cjs-module-lexer cannot statically resolve as a named export
  // (a well-known TS+cjs-module-lexer interop limitation, not a sox bug) — so
  // `import { atomicTscExecutor } from '@adhd/sox-nx'` would break, but
  // nothing in this repo or nx's own loading mechanism ever does that import.
  '@adhd/sox-nx': ['named-exports'],
};

const violations = [];
let publintChecked = 0;
let attwChecked = 0;
let attwSkipped = 0;

let dirsToCheck = workspacePackageDirs();
if (ONLY_DIRS) {
  const onlySet = new Set(ONLY_DIRS);
  const missing = ONLY_DIRS.filter((d) => !dirsToCheck.includes(d));
  dirsToCheck = dirsToCheck.filter((d) => onlySet.has(d));
  console.error(
    `verify-exports-publint-attw: scoped (--only) to ${dirsToCheck.length} of ${workspacePackageDirs().length} workspace package(s): ` +
    dirsToCheck.map((d) => path.relative(ROOT, d)).join(', '),
  );
  if (missing.length > 0) {
    // A caller-supplied --only dir that isn't a real workspace-package dir is a
    // caller bug (stale nx-graph root, typo) — surface it instead of silently
    // checking fewer packages than intended.
    console.error(`verify-exports-publint-attw: WARNING — ${missing.length} --only dir(s) are not workspace package dirs and were ignored: ${missing.map((d) => path.relative(ROOT, d)).join(', ')}`);
  }
}

for (const dir of dirsToCheck) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (e) {
    violations.push({ tool: 'parse', pkg: path.relative(ROOT, dir), detail: String(e) });
    continue;
  }
  if (!pkg.name) continue;
  if (!hasContractPaths(pkg)) continue;

  // ---- publint: universal file-existence + packaging correctness gate ----
  publintChecked++;
  try {
    execFileSync(BIN('publint'), ['run', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    violations.push({ tool: 'publint', pkg: pkg.name, detail: out.trim() });
  }

  // ---- attw: type-resolution gate, scoped to libs/ + packages/ ----
  if (!attwInScope(dir)) { attwSkipped++; continue; }
  if (!pkg.types && !(pkg.exports && JSON.stringify(pkg.exports).includes('"types"'))) {
    attwSkipped++; // no type declarations to check
    continue;
  }
  attwChecked++;
  const isEsmOnly = pkg.type === 'module';
  const profile = isEsmOnly ? 'esm-only' : 'strict';
  const ignoreRules = KNOWN_ACCEPTED_ATTW[pkg.name] || [];
  const attwArgs = ['--pack', '--profile', profile, '--format', 'json', dir];
  if (ignoreRules.length > 0) attwArgs.push('--ignore-rules', ...ignoreRules);
  try {
    execFileSync(BIN('attw'), attwArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    let problems = [];
    try {
      const parsed = JSON.parse(e.stdout || '{}');
      problems = parsed.analysis?.problems || [];
    } catch {
      // non-JSON failure (e.g. pack itself failed) — surface raw output
    }
    if (problems.length > 0) {
      const summary = problems.map((p) => `${p.kind} (${p.entrypoint ?? '.'}, ${p.resolutionKind ?? 'n/a'})`).join('; ');
      violations.push({ tool: 'attw', pkg: pkg.name, detail: summary });
    } else if (!(e.stdout || '').trim().startsWith('{')) {
      violations.push({ tool: 'attw', pkg: pkg.name, detail: ((e.stdout || '') + (e.stderr || '')).trim() });
    }
  }
}

if (violations.length > 0) {
  console.error(`verify-exports-publint-attw: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  [${v.tool}] ${v.pkg}`);
    for (const line of v.detail.split('\n')) console.error(`      ${line}`);
  }
  console.error('');
  console.error('A package fails packaging correctness (publint) or type/runtime-format');
  console.error('resolution (attw). See docs/standards/extension-bundling.md for the contract');
  console.error('these tools enforce, or docs/standards/module-resolution.md §4b.');
  process.exit(1);
}
console.error(
  `verify-exports-publint-attw: OK — publint ${publintChecked} package(s); ` +
  `attw ${attwChecked} package(s) (${attwSkipped} out of scope or untyped).`,
);
