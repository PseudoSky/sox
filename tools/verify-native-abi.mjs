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
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const NODE_ABI = process.versions.modules;
const NODE_VER = process.version;

// ── BL-222: install-root resolution ─────────────────────────────────────────
//
// REPO_ROOT (above) is derived from this script's own __dirname. Inside a
// linked git worktree, that resolves to the *worktree's* root — which was
// checked out fresh from tracked files and has NO node_modules/ (gitignored,
// never installed per-worktree in this repo's workflow). Probing REPO_ROOT in
// that case finds nothing, and the naive fix of swapping in
// `git rev-parse --show-toplevel` is a no-op: it returns the exact same
// worktree-root path as __dirname/.. does.
//
// The actual fix: `git rev-parse --git-common-dir` returns the *shared* .git
// directory — the main checkout's .git when run from a linked worktree, or
// the local .git when run from the main checkout itself. Its parent is the
// one checkout in this workflow that actually has `pnpm install` run against
// it. Resolve native-addon probes against THAT root, not the worktree root.
function resolveInstallRoot() {
  try {
    const gitCommonDir = execFileSync(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const resolved = path.resolve(__dirname, gitCommonDir);
    return path.dirname(resolved);
  } catch {
    // Not a git checkout, or `git` unavailable — fall back to REPO_ROOT.
    return REPO_ROOT;
  }
}

const INSTALL_ROOT = resolveInstallRoot();
const IN_WORKTREE = INSTALL_ROOT !== REPO_ROOT;

/** Translate a path rooted at REPO_ROOT (the script's own checkout) to the
 *  equivalent path rooted at INSTALL_ROOT (the checkout with the real
 *  install). No-op when they're the same (i.e. not running from a worktree). */
function toInstallPath(scriptTreePath) {
  if (!IN_WORKTREE) return scriptTreePath;
  return path.join(INSTALL_ROOT, path.relative(REPO_ROOT, scriptTreePath));
}

/** True if `root` has ANY install at all — i.e. there is something to verify. */
function installRootHasInstall(root) {
  return (
    fs.existsSync(path.join(root, 'node_modules', '.pnpm')) ||
    fs.existsSync(path.join(root, 'node_modules'))
  );
}

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
  const base = resolveFrom ?? INSTALL_ROOT;
  // Walk up from resolveFrom looking for node_modules/<pkg>
  let dir = base;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(candidate)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Also check pnpm's virtual store at the install root (BL-222: NOT
  // REPO_ROOT — inside a worktree REPO_ROOT never has an install).
  const pnpmStore = path.join(INSTALL_ROOT, 'node_modules/.pnpm');
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

if (IN_WORKTREE) {
  console.log(`  (running from a linked worktree — resolving installs against`);
  console.log(`   the main checkout: ${INSTALL_ROOT})\n`);
}

// BL-222: fail loudly — do not silently report "all OK" — when the install
// root has no install at all. Previously every probe fell through the
// per-package "not installed — optional dep" skip in this situation (which
// is meant for genuinely-optional deps, not "nothing was ever installed"),
// so the script printed "all native addons OK" and exited 0 having verified
// nothing whatsoever. A verification tool that silently passes when it can't
// find what it's supposed to verify is worse than no tool.
if (!installRootHasInstall(INSTALL_ROOT)) {
  console.error(`  FAIL  no install found at all`);
  console.error(`        Checked: ${path.join(INSTALL_ROOT, 'node_modules')}`);
  if (IN_WORKTREE) {
    console.error(
      `        This is a linked git worktree (script root: ${REPO_ROOT}).`,
    );
    console.error(
      `        node_modules/ is gitignored and was not found in the main checkout either.`,
    );
  }
  console.error(`\n        Fix: run \`pnpm install\` in ${INSTALL_ROOT}, then re-run this script.\n`);
  console.error(
    `verify-native-abi: cannot verify — no install present. This is a hard failure, not a skip.\n`,
  );
  process.exit(1);
}

let failures = 0;

for (const { pkg, resolveFrom: resolveFromScriptTree, description } of NATIVE_PROBES) {
  const resolveFrom = toInstallPath(resolveFromScriptTree);

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
