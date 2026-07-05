#!/usr/bin/env node
/**
 * tools/verify-native-abi.mjs — BL-94 ABI mismatch enforcement.
 *
 * Attempts to load every native addon used across the workspace.  Exits non-zero
 * with a clear diagnosis + rebuild command if any addon fails to load.
 *
 * Run manually after a Node.js version change:
 *   node tools/verify-native-abi.mjs
 *
 * Also wired as `pnpm verify:abi` (root package.json "scripts").
 *
 * Exit codes:
 *   0 — all native addons loaded successfully
 *   1 — one or more addons failed to load (ABI mismatch or missing binding)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const NODE_ABI = process.versions.modules;
const NODE_VER = process.version;

// ── Native packages to probe ──────────────────────────────────────────────────
//
// Each entry: { pkg, resolveFrom, description }
//   pkg          — the package name passed to require()
//   resolveFrom  — directory from which to resolve (nearest consumer).
//                  undefined → resolve from REPO_ROOT.
//   description  — human-readable name for the diagnostic line.
//
// Add new native deps here when they appear in the workspace.

const NATIVE_PROBES = [
  {
    pkg: 'better-sqlite3',
    resolveFrom: path.join(
      REPO_ROOT,
      'extensions/bundles/sox-memory-bundle/members/memory-server',
    ),
    description: 'better-sqlite3 (memory-server sqlite backend)',
  },
  {
    pkg: 'onnxruntime-node',
    resolveFrom: path.join(
      REPO_ROOT,
      'extensions/bundles/sox-memory-bundle/members/memory-server',
    ),
    description: 'onnxruntime-node (memory-server embedding inference)',
  },
];

// ── Probe helpers ─────────────────────────────────────────────────────────────

/**
 * Attempt to require a native package.  Returns { ok, error }.
 * Uses a resolveFrom-rooted require so pnpm's isolated layout is honoured.
 */
function probe(pkg, resolveFrom) {
  try {
    const localRequire = resolveFrom
      ? createRequire(path.join(resolveFrom, 'package.json'))
      : require;
    localRequire(pkg);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Check whether a package is actually installed under resolveFrom before
 * trying to load it.  Avoids a scary error when a package is an optional dep
 * that isn't installed on this machine.
 */
function isInstalled(pkg, resolveFrom) {
  const base = resolveFrom ?? REPO_ROOT;
  // Walk up from resolveFrom looking for node_modules/<pkg>
  let dir = base;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(candidate)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Also check pnpm's virtual store at root
  const pnpmStore = path.join(
    REPO_ROOT,
    'node_modules/.pnpm',
  );
  if (fs.existsSync(pnpmStore)) {
    const entries = fs.readdirSync(pnpmStore).filter((e) =>
      e.startsWith(pkg.replace('/', '+') + '@') || e.startsWith(pkg + '@'),
    );
    if (entries.length > 0) return true;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(
  `\nverify-native-abi — Node ${NODE_VER} (ABI ${NODE_ABI})\n`,
);

let failures = 0;

for (const { pkg, resolveFrom, description } of NATIVE_PROBES) {
  if (!isInstalled(pkg, resolveFrom)) {
    console.log(`  skip  ${description}  (not installed — optional dep)`);
    continue;
  }

  const { ok, error } = probe(pkg, resolveFrom);

  if (ok) {
    console.log(`  ok    ${description}`);
  } else {
    failures++;
    console.error(`\n  FAIL  ${description}`);
    console.error(`        ${error?.message ?? String(error)}`);
    console.error(`\n        The native binding was compiled for a different Node.js ABI.`);
    console.error(`        Current ABI: ${NODE_ABI} (Node ${NODE_VER})`);
    console.error(`\n        Fix: run one of the following from the repo root:\n`);
    console.error(`          pnpm rebuild ${pkg}`);
    console.error(`          # or, to rebuild all native addons:`);
    console.error(`          pnpm rebuild\n`);
  }
}

console.log('');

if (failures > 0) {
  console.error(
    `verify-native-abi: ${failures} native addon(s) failed ABI check. See above.\n`,
  );
  process.exit(1);
} else {
  console.log(`verify-native-abi: all native addons OK.\n`);
  process.exit(0);
}
