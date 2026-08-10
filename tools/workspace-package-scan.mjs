#!/usr/bin/env node
/**
 * tools/workspace-package-scan.mjs — BL-192 smoke-gate coverage-gap fix.
 *
 * Pure functions (zero side effects at import) for locating workspace packages
 * and the filesystem paths their package.json contract (main/module/types/bin/
 * exports) requires to exist. Shared by:
 *
 *   - tools/verify-exports-publint-attw.mjs   (BL-266 preflight package discovery)
 *   - scripts/smoke-test.mjs                  (BL-192 Build-first gate — extended so
 *                                              ANY unbuilt package aborts with the
 *                                              clear FATAL *before* the preflight runs)
 *   - scripts/workspace-package-scan.test.mjs (unit pin)
 *
 * The BL-192 gate previously verified only dist/apps/sox/main.js plus the
 * filtered extensions' entrypoints. A partial build (e.g. `nx affected:build`,
 * which structurally skips zero-dependency packages) sails through that gate and
 * detonates inside the BL-266 publint preflight with cryptic "file does not
 * exist" errors for @adhd/sox-nx, @adhd/sox-baseline-capture,
 * @adhd/sox-source-provider. Walking the same contract paths up front turns that
 * into a clear Build-first FATAL.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Leftover atomic-build scratch dirs, as produced by @adhd/sox-nx:atomic-tsc
 * (`<outputPath>.staging-<pid>` / `.prev-<pid>` — e.g. `dist.staging-1234`) and
 * tools/bundle-extension.cjs (`bundle.staging-<pid>`). A hard-killed build can
 * leave one behind; they carry package.json only as build scaffolding and must
 * never be treated as workspace packages.
 */
const SCRATCH_DIR_RE = /\.(staging|prev)-\d+$/;

/** Top-level dirs under the workspace root that can contain workspace packages. */
const SCAN_BASES = ['extensions', 'apps', 'libs', 'packages', 'tools'];

/**
 * Every dir under root/{extensions,apps,libs,packages,tools} that contains a
 * package.json — excluding node_modules/, dist/, and leftover atomic-build
 * scratch dirs (dist.staging-<pid>, dist.prev-<pid>, bundle.staging-<pid> …).
 *
 * Recursive (a package can nest under libs/data/graph/graph-store/…). Sorted
 * for deterministic output.
 *
 * @param {string} root workspace root (absolute path preferred)
 * @returns {string[]}
 */
export function workspacePackageDirs(root) {
  const dirs = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // base dir absent (e.g. no apps/ in a stripped checkout)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (SCRATCH_DIR_RE.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, 'package.json'))) dirs.push(full);
      walk(full);
    }
  };
  for (const base of SCAN_BASES) walk(path.join(root, base));
  return dirs.sort();
}

/**
 * True if the package declares any path-bearing contract field: main, module,
 * types, exports, or bin (string or non-empty object). Mirrors the BL-266
 * preflight's notion of "a package publint must check".
 *
 * @param {object} pkg parsed package.json
 * @returns {boolean}
 */
export function hasContractPaths(pkg) {
  if (pkg.main || pkg.module || pkg.types || pkg.exports) return true;
  if (typeof pkg.bin === 'string') return true;
  if (pkg.bin && typeof pkg.bin === 'object' && Object.keys(pkg.bin).length > 0) return true;
  return false;
}

/**
 * Absolute paths a package's declared contract requires to exist. `[]` when
 * hasContractPaths(pkg) is false.
 *
 * Coverage mirrors the publint file-existence contract:
 *   - main / module / types
 *   - bin (string, or every object value)
 *   - a FULL recursive walk of exports: string values, condition-object
 *     values, array elements, nested conditions.
 *
 * Skipped values: non-strings, `node:` / `npm:` schemes, URL schemes
 * (scheme://…), bare package names (no '/'), and ''. Results are deduplicated.
 *
 * @param {string} pkgDir package directory (absolute)
 * @param {object} pkg parsed package.json
 * @returns {string[]}
 */
export function contractArtifactPaths(pkgDir, pkg) {
  if (!hasContractPaths(pkg)) return [];
  const out = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const s = value.trim();
    if (!s) return;
    if (/^(node|npm):/.test(s)) return; // node:/npm: builtin scheme
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return; // URL scheme (http:, file:, data: …)
    if (!s.includes('/')) return; // bare package name — not a filesystem path
    out.add(path.resolve(pkgDir, s));
  };
  const walkExports = (node) => {
    if (typeof node === 'string') {
      add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const element of node) walkExports(element);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walkExports(value);
    }
  };
  for (const field of ['main', 'module', 'types']) add(pkg[field]);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) add(value);
  }
  walkExports(pkg.exports);
  return [...out];
}
