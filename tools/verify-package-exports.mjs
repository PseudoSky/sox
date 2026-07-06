#!/usr/bin/env node
/**
 * verify-package-exports.mjs — the dist-layout CONTRACT guard.
 *
 * Every workspace package's `package.json` entry points (`main`, `types`,
 * `module`, `bin`, and every path leaf inside `exports`) must resolve to a
 * real file. This is the other half of any build-output change: the
 * 2026-07-04 @nx/js:tsc migration (0ba5d78) moved emit to `dist/src/**`
 * while every consumer contract pointed at flat `dist/index.*` — and the
 * break was CACHE-MASKED until an unrelated doc edit busted one project's
 * inputs. This guard makes that class fail loudly in the mandatory smoke
 * gate instead of hiding behind the nx cache.
 *
 * Usage:  node tools/verify-package-exports.mjs [--root <repo>]
 * Exit:   0 = every contract path resolves; 1 = violations (listed).
 *
 * Scope: workspace packages per pnpm-workspace.yaml globs, excluding
 * node_modules/ and dist/ (build-emitted package.json files are not
 * contracts). Packages whose entry fields point at source files (./src/…)
 * are checked identically — the rule is simply "the path must exist".
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot() {
  const argIdx = process.argv.indexOf('--root');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return path.resolve(process.argv[argIdx + 1]);
  try {
    // BL-208 lesson: resolve via git, not the script's own path — in a
    // worktree the script's copy lives under the worktree root, which is
    // ALSO the correct root there; git gives the right answer in both.
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }
}

const ROOT = repoRoot();

/** Workspace package dirs per pnpm-workspace.yaml globs (kept in sync manually — the globs are stable). */
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
  scanChildren(path.join(ROOT, 'extensions'), 2);            // extensions/*/*
  // extensions/bundles/*/members/*
  const bundles = path.join(ROOT, 'extensions', 'bundles');
  if (fs.existsSync(bundles)) {
    for (const b of fs.readdirSync(bundles, { withFileTypes: true })) {
      if (!b.isDirectory()) continue;
      scanChildren(path.join(bundles, b.name, 'members'), 1);
    }
  }
  scanChildren(path.join(ROOT, 'apps'), 3);                  // apps/**
  scanChildren(path.join(ROOT, 'libs'), 3);                  // libs/**
  scanChildren(path.join(ROOT, 'packages'), 2);              // packages/**
  scanChildren(path.join(ROOT, 'tools'), 1);                 // tools/*
  return [...dirs].sort();
}

/** Collect every relative-path leaf from main/module/types/bin/exports. */
function contractPaths(pkg) {
  const out = new Map(); // path -> field label
  const add = (p, label) => {
    if (typeof p === 'string' && p.startsWith('./')) out.set(p, label);
  };
  add(pkg.main, 'main');
  add(pkg.module, 'module');
  add(pkg.types, 'types');
  if (typeof pkg.bin === 'string') add(pkg.bin, 'bin');
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [k, v] of Object.entries(pkg.bin)) add(v, `bin.${k}`);
  }
  const walkExports = (node, label) => {
    if (typeof node === 'string') { add(node, label); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walkExports(v, `${label}[${k}]`);
    }
  };
  if (pkg.exports !== undefined) walkExports(pkg.exports, 'exports');
  return out;
}

const violations = [];
let checkedPkgs = 0;
let checkedPaths = 0;
for (const dir of workspacePackageDirs()) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (e) {
    violations.push({ pkg: path.relative(ROOT, dir), field: 'package.json', path: '(unparseable)', err: String(e) });
    continue;
  }
  if (!pkg.name) continue; // build-emitted / anonymous manifests are not contracts
  const paths = contractPaths(pkg);
  if (paths.size === 0) continue;
  checkedPkgs++;
  for (const [rel, label] of paths) {
    checkedPaths++;
    if (!fs.existsSync(path.join(dir, rel))) {
      violations.push({ pkg: pkg.name, field: label, path: rel, err: 'file does not exist' });
    }
  }
}

if (violations.length > 0) {
  console.error(`verify-package-exports: ${violations.length} contract violation(s):`);
  for (const v of violations) {
    console.error(`  - ${v.pkg}: ${v.field} -> ${v.path} (${v.err})`);
  }
  console.error('A package.json entry point references a file that does not exist.');
  console.error('Either the workspace is not built (`npx nx run-many -t build`) or a build-');
  console.error('layout change broke the exports contract (see docs/standards/module-resolution.md).');
  process.exit(1);
}
console.error(`verify-package-exports: OK — ${checkedPaths} contract paths across ${checkedPkgs} packages all resolve.`);
